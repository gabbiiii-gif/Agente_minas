import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import type Anthropic from "@anthropic-ai/sdk";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import { gravarConfig } from "../../src/config/loja.js";
import { criarAtendimento, type Atendimento } from "../../src/gateway/atender.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

const PREFIXO = "55939111";
const EVOLUTION = { url: "http://evolution.teste", apiKey: "k", instancia: "minas" };

/** Cada teste usa um telefone só seu: o estado do contato é durável. */
const tel = (n: number) => `${PREFIXO}0${String(n).padStart(4, "0")}`;

function eventoTexto(telefone: string, id: string, texto = "tem retentor pra titan 160?") {
  return {
    event: "messages.upsert",
    data: {
      key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id },
      pushName: "Teste",
      message: { conversation: texto },
      messageType: "conversation",
    },
  };
}

/** Modelo falso: responde texto, sem pedir ferramenta. */
function anthropicFalso(texto = "Tem sim. Retentor dianteiro Titan 160, código 4402.") {
  return {
    messages: {
      create: async () => ({
        id: "msg_teste",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: texto, citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 2200,
          cache_creation_input_tokens: 0,
        },
      }),
    },
  } as unknown as Anthropic;
}

descrever("atendimento", () => {
  let pool: Pool;
  let enviados: Array<{ number: string; text: string }>;

  const contar = async (telefone: string, papel: string) => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n
         from agente.mensagens m
         join agente.conversas c on c.id = m.conversa_id
         join agente.contatos ct on ct.id = c.contato_id
        where ct.telefone = $1 and m.papel = $2`,
      [telefone, papel],
    );
    return Number(rows[0]!.n);
  };

  const conversaDe = async (telefone: string) => {
    const { rows } = await pool.query(
      `select c.id, c.status, ct.silenciado_ate
         from agente.conversas c
         join agente.contatos ct on ct.id = c.contato_id
        where ct.telefone = $1
        order by c.iniciada_em desc limit 1`,
      [telefone],
    );
    return rows[0]!;
  };

  /** Janela longa: o turno não dispara sozinho, cada teste o chama quando quer. */
  const novo = (anthropic: Anthropic = anthropicFalso()): Atendimento =>
    criarAtendimento({ pool, anthropic, evolution: EVOLUTION, esperaDebounceMs: 60_000 });

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await pool.query(`delete from agente.contatos where telefone like '${PREFIXO}%'`);
    await gravarConfig(pool, { botAtivo: true, maxMensagensConversa: 30 });
  });

  afterAll(async () => {
    await pool.query(`delete from agente.contatos where telefone like '${PREFIXO}%'`);
    // Restaura tudo, inclusive o que um teste que falhou no meio deixaria
    // torto: config torta aqui quebra o teste seguinte, não este.
    await gravarConfig(pool, {
      botAtivo: true,
      maxMensagensConversa: 30,
      tetoContatosNovosHora: 12,
    });
    await pool.end();
  });

  beforeEach(() => {
    enviados = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      enviados.push(JSON.parse(init.body as string));
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
  });

  it("grava a mensagem do cliente e agenda o turno", async () => {
    const a = novo();
    await a.atender(eventoTexto(tel(1), "A-1"));

    expect(await contar(tel(1), "cliente")).toBe(1);
    expect(a.pendentes()).toBe(1);
    a.encerrar();
  });

  it("webhook repetido não grava nem agenda de novo", async () => {
    const a = novo();
    await a.atender(eventoTexto(tel(2), "B-1"));
    a.encerrar(); // limpa o agendamento do primeiro, para o segundo ser visível

    await a.atender(eventoTexto(tel(2), "B-1"));

    // O Evolution reenvia quando não recebe 200 a tempo; responder duas vezes
    // é o erro que o cliente percebe na hora.
    expect(await contar(tel(2), "cliente")).toBe(1);
    expect(a.pendentes()).toBe(0);
    a.encerrar();
  });

  it("mensagem do balcão cala o bot e entra como fala do humano", async () => {
    const a = novo();
    const evento = eventoTexto(tel(3), "C-1", "já separo aqui");
    evento.data.key.fromMe = true;

    await a.atender(evento);

    const conversa = await conversaDe(tel(3));
    expect(await contar(tel(3), "humano")).toBe(1);
    expect(conversa.status).toBe("aguardando_humano");
    expect(conversa.silenciado_ate).not.toBeNull();
    expect(a.pendentes()).toBe(0);
    a.encerrar();
  });

  it("não agenda turno para quem o balcão já assumiu", async () => {
    const a = novo();
    const doBalcao = eventoTexto(tel(4), "D-1", "pode deixar");
    doBalcao.data.key.fromMe = true;
    await a.atender(doBalcao);

    await a.atender(eventoTexto(tel(4), "D-2", "e o preço?"));

    // A mensagem entra no histórico de qualquer jeito — o painel precisa ver
    // a conversa inteira mesmo com a IA calada.
    expect(await contar(tel(4), "cliente")).toBe(1);
    expect(a.pendentes()).toBe(0);
    a.encerrar();
  });

  it("não agenda turno com o bot desligado no painel", async () => {
    await gravarConfig(pool, { botAtivo: false });
    const a = novo();

    await a.atender(eventoTexto(tel(5), "E-1"));

    expect(await contar(tel(5), "cliente")).toBe(1);
    expect(a.pendentes()).toBe(0);
    a.encerrar();
    await gravarConfig(pool, { botAtivo: true });
  });

  it("passa para o balcão quando a conversa estoura o teto de mensagens", async () => {
    await gravarConfig(pool, { maxMensagensConversa: 2 });
    const a = novo();

    await a.atender(eventoTexto(tel(6), "F-1"));
    a.encerrar();
    await a.atender(eventoTexto(tel(6), "F-2"));
    a.encerrar();
    await a.atender(eventoTexto(tel(6), "F-3"));

    expect((await conversaDe(tel(6))).status).toBe("aguardando_humano");
    expect(enviados.at(-1)!.text).toContain("balcão");
    expect(a.pendentes()).toBe(0);
    a.encerrar();
    await gravarConfig(pool, { maxMensagensConversa: 30 });
  });

  it("cala e entrega ao balcão quando estoura o teto de contatos novos", async () => {
    await gravarConfig(pool, { tetoContatosNovosHora: 0 });
    const a = novo();

    await a.atender(eventoTexto(tel(9), "I-1"));

    // Não manda NADA: avisar seria mandar mensagem para contato novo, que é
    // exatamente o padrão que o WhatsApp pune.
    expect(enviados).toHaveLength(0);
    expect((await conversaDe(tel(9))).status).toBe("aguardando_humano");
    expect(await contar(tel(9), "cliente")).toBe(1);
    expect(a.pendentes()).toBe(0);
    a.encerrar();
    await gravarConfig(pool, { tetoContatosNovosHora: 12 });
  });

  it("responde o turno, grava a fala do agente e entrega pelo evolution", async () => {
    const a = novo();
    await a.atender(eventoTexto(tel(7), "G-1"));
    const conversa = await conversaDe(tel(7));

    await a.responderTurno(conversa.id);

    expect(await contar(tel(7), "agente")).toBe(1);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.number).toBe(tel(7));
    expect(enviados[0]!.text).toContain("4402");
    a.encerrar();
  });

  it("entrega ao balcão quando o modelo falha", async () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    const quebrado = {
      messages: {
        create: async () => {
          throw new Error("anthropic fora do ar");
        },
      },
    } as unknown as Anthropic;

    const a = novo(quebrado);
    await a.atender(eventoTexto(tel(8), "H-1"));
    const conversa = await conversaDe(tel(8));

    await a.responderTurno(conversa.id);

    // O cliente não pode ficar no vácuo: avisa e passa adiante.
    expect(enviados.at(-1)!.text).toContain("minuto");
    expect((await conversaDe(tel(8))).status).toBe("aguardando_humano");
    expect(erros).toHaveBeenCalled();
    a.encerrar();
    erros.mockRestore();
  });
});
