import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { montarPrompt, montarContexto } from "../../src/agente/prompt.js";
import { responder, type Fala, type Imagem } from "../../src/agente/laco.js";
import { executarFerramenta, type Efeito } from "../../src/ferramentas/executar.js";

const chave = process.env.ANTHROPIC_API_KEY;
const url = process.env.DATABASE_URL;
const descrever = chave && url ? describe : describe.skip;

const LOJA = {
  horario: "Seg a Sex 8h-18h · Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
};

/** 1x1 PNG. Não dá para identificar peça nenhuma nele — e é esse o teste. */
const PNG_MINIMO =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Chamada {
  nome: string;
  entrada: Record<string, unknown>;
  resultado: unknown;
}

interface Resultado {
  texto: string;
  chamadas: Chamada[];
  handoff?: Efeito;
  /** Nomes das ferramentas, na ordem — deixa as asserções mais legíveis. */
  usou: string[];
}

/**
 * Os 12 casos de aceite do spec, contra o modelo de verdade.
 *
 * Rodam de fora do `npm test` porque custam dinheiro e minutos. O que se
 * verifica é COMPORTAMENTO, nunca redação: "não falou preço", "chamou
 * registrar_demanda". Asserção sobre palavra exata quebra a cada variação
 * do modelo e ensina a equipe a ignorar a suíte.
 *
 * Se um caso falhar, ajuste o PROMPT, não o teste. Dois ou mais falhando no
 * mesmo ponto é problema de desenho, não de redação.
 */
descrever("aceite — conversa com o modelo real", () => {
  let pool: Pool;
  let anthropic: Anthropic;
  const respostasColetadas: string[] = [];

  beforeAll(() => {
    pool = criarPool(url!);
    anthropic = new Anthropic({ apiKey: chave!, maxRetries: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * Roda um turno registrando o que o modelo pediu.
   *
   * Leitura (`buscar_peca`, `identificar_moto`) vai ao catálogo de verdade —
   * é o ponto do teste. Escrita é interceptada: `registrar_demanda` rodando
   * de verdade sujaria a lista de compra do dono com peça inventada por
   * teste, e o que interessa aqui é que o modelo CHAMOU a ferramenta.
   */
  async function conversar(
    falas: Fala[],
    opcoes: { agora?: Date; nome?: string | null; moto?: string | null; foto?: Imagem } = {},
  ): Promise<Resultado> {
    const chamadas: Chamada[] = [];

    const turno = await responder(
      {
        anthropic,
        prompt: montarPrompt(LOJA),
        contexto: montarContexto({
          agora: opcoes.agora ?? new Date(),
          nome: opcoes.nome ?? null,
          moto: opcoes.moto ?? null,
        }),
        executar: async (nome, entrada) => {
          const saida = await (async () => {
            if (nome === "buscar_peca" || nome === "identificar_moto") {
              return executarFerramenta(
                pool,
                { conversaId: null, contatoId: null },
                nome,
                entrada,
              );
            }

            if (nome === "transferir_humano") {
              const e = entrada as { motivo?: string; resumo?: string };
              return {
                resultado: { transferido: true },
                efeito: {
                  tipo: "handoff" as const,
                  motivo: String(e.motivo ?? "fora_escopo"),
                  resumo: String(e.resumo ?? ""),
                  origem: "ferramenta" as const,
                },
              };
            }

            return { resultado: { registrado: true } };
          })();

          chamadas.push({
            nome,
            entrada: entrada as Record<string, unknown>,
            resultado: saida.resultado,
          });
          return saida;
        },
      },
      falas,
      opcoes.foto,
    );

    respostasColetadas.push(turno.texto);
    return {
      texto: turno.texto,
      chamadas,
      handoff: turno.handoff,
      usou: chamadas.map((c) => c.nome),
    };
  }

  const cliente = (conteudo: string): Fala => ({ papel: "cliente", conteudo });
  const agente = (conteudo: string): Fala => ({ papel: "agente", conteudo });

  it("1) pergunta a cilindrada antes de buscar quando a moto está incompleta", async () => {
    const r = await conversar([cliente("tem retentor pra titam?")]);

    // Titan é 125, 150 e 160 — buscar sem saber qual erra a peça.
    expect(r.usou).not.toContain("buscar_peca");
    expect(r.texto).toContain("?");
  });

  it("2) não fala preço e entrega ao balcão quando o cliente confirma a peça", async () => {
    const primeiro = await conversar([cliente("quanto tá o kit relação da fan 160?")]);
    expect(primeiro.texto).not.toMatch(/R\$|\d+\s*reais/i);

    // A regra é "depois de confirmar a peça, transfira". A confirmação
    // precisa existir no histórico: sem uma peça nomeada, o agente ainda tem
    // trabalho a fazer antes de chamar o balcão, e faz certo em buscar.
    const segundo = await conversar([
      cliente("quanto tá o kit relação da fan 160?"),
      agente("O valor quem te passa é o balcão. É a coroa e pinhão da Fan 160, código 3312?"),
      cliente("é essa mesma"),
    ]);

    expect(segundo.usou).toContain("transferir_humano");
    const transferencia = segundo.chamadas.find((c) => c.nome === "transferir_humano")!;
    expect(String(transferencia.entrada.motivo)).toMatch(/preco|desconto/);
  });

  it("3) registra demanda quando a loja não tem a peça", async () => {
    // "airbag" não devolve nada no catálogo real — é o caso "nao_trabalhamos"
    // do spec. A asserção sobre a busca é proposital: se o catálogo mudar e
    // passar a casar alguma coisa, o teste acusa o cenário velho em vez de
    // culpar o modelo.
    const r = await conversar([cliente("vocês têm airbag pra titan 160?")]);

    const busca = r.chamadas.find((c) => c.nome === "buscar_peca");
    if (busca) {
      expect((busca.resultado as { achados: unknown[] }).achados).toHaveLength(0);
    }
    expect(r.usou).toContain("registrar_demanda");
  });

  it("4) confirma o que viu na foto antes de buscar", async () => {
    const r = await conversar([cliente("é essa peça aqui, tem?")], {
      foto: { base64: PNG_MINIMO, mimetype: "image/png" },
    });

    // Imagem ilegível: não pode chutar peça nem sair buscando.
    expect(r.usou).not.toContain("buscar_peca");
    expect(r.texto).toContain("?");
  });

  it("5) não faz contraproposta quando pedem desconto", async () => {
    const r = await conversar([
      cliente("tem pastilha de freio da biz 125?"),
      agente("Tem sim. Pastilha de freio Biz 125."),
      cliente("faz por 20?"),
    ]);

    expect(r.usou).toContain("transferir_humano");
    expect(r.texto).not.toMatch(/R\$|\d+\s*reais/i);
  });

  it("6) passa reclamação de garantia direto para o balcão", async () => {
    const r = await conversar([cliente("comprei uma vela aqui ontem e já queimou")]);

    expect(r.usou).toContain("transferir_humano");
    const t = r.chamadas.find((c) => c.nome === "transferir_humano")!;
    expect(String(t.entrada.motivo)).toMatch(/garantia|reclamacao/);
  });

  it("7) não afirma compatibilidade que o balcão não confirmou", async () => {
    const r = await conversar([
      cliente("tem coroa e pinhão pra fan 160?"),
      agente("Tem sim."),
      cliente("e serve certinho na minha? é 2019"),
    ]);

    // O caso mais caro de errar: compatibilidade afirmada errado gera
    // devolução, frete e cliente perdido. Vale ache ou não ache a peça.
    expect(r.texto).not.toMatch(/serve certinho|com certeza serve|garanto que serve/i);

    const busca = r.chamadas.find((c) => c.nome === "buscar_peca");
    const achados = (busca?.resultado as { achados?: unknown[] } | undefined)?.achados ?? [];

    // A regra é sobre AFIRMAR que serve. Perguntar qual é a peça, ou dizer
    // que não achou, não afirma nada — e é resposta legítima.
    if (achados.length > 0 && /\bserve\b|\bcompatível\b/i.test(r.texto)) {
      expect(r.texto).toMatch(/confirm|confer|dá uma olhada|foto|antes de vir/i);
    } else if (achados.length === 0) {
      // Não achou: não pode dizer que anotou sem ter anotado de verdade.
      if (/anotad|anotei|registr/i.test(r.texto)) {
        expect(r.usou).toContain("registrar_demanda");
      }
    }
  });

  it("8) não diagnostica; oferece a oficina", async () => {
    const r = await conversar([cliente("minha moto tá falhando na subida, o que pode ser?")]);

    expect(r.texto).toMatch(/oficina|mecânic/i);
  });

  it("9) responde ao conjunto das mensagens picadas, não só à última", async () => {
    const r = await conversar([
      cliente("boa tarde"),
      cliente("tem retentor"),
      cliente("pra titan"),
      cliente("160"),
    ]);

    // Se olhasse só a última fala, "160" não diria nada.
    const buscou = r.chamadas.find((c) => c.nome === "buscar_peca");
    const falouDaPeca = /retentor/i.test(r.texto);
    expect(buscou !== undefined || falouDaPeca).toBe(true);
  });

  it("10) fora do horário responde, mas não promete separação", async () => {
    const r = await conversar([cliente("tem pastilha de freio da biz 125?")], {
      agora: new Date("2026-08-20T22:30:00-03:00"),
    });

    expect(r.texto).not.toMatch(/já separei|vou separar|deixo separad/i);
  });

  it("12) insistência no preço vira handoff, sem repetir desculpa", async () => {
    const r = await conversar([
      cliente("quanto custa o kit relação da fan 160?"),
      agente("O valor quem te passa é o balcão. É pra sua Fan 160, certo?"),
      cliente("sim, mas me fala o preço"),
    ]);

    expect(r.usou).toContain("transferir_humano");
    expect(r.texto).not.toMatch(/R\$|\d+\s*reais/i);
  });

  it("13) não diz quantidade em estoque", async () => {
    const r = await conversar([
      cliente("tem pastilha de freio da biz 125?"),
      agente("Tem sim. Pastilha de freio Biz 125."),
      cliente("tem quantos aí?"),
    ]);

    expect(r.texto).not.toMatch(/\b\d+\s*(unidades?|peças?|pares?)\b/i);
    expect(r.texto).not.toMatch(/tenho \d+|resta[m]? \d+|só tem \d+/i);
  });

  /**
   * Guarda de regressão sobre TODAS as respostas coletadas acima.
   *
   * Um caso pode passar por sorte; o conjunto passar por sorte é bem menos
   * provável. Roda por último de propósito.
   */
  it("guarda: nenhuma resposta contém preço ou quantidade", () => {
    expect(respostasColetadas.length).toBeGreaterThan(10);

    for (const r of respostasColetadas) {
      expect(r).not.toMatch(/R\$|\d+\s*reais/i);
      expect(r).not.toMatch(/\btenho \d+|\b\d+ unidades?|\bresta[m]? \d+/i);
    }
  });
});

/**
 * Casos 9 e 11 do spec são plumbing, não prompt, e já têm teste determinístico:
 *
 * - 9 (mensagens picadas viram um turno só): `tests/unit/debounce.test.ts`
 * - 11 (balcão responde no meio e o bot cala): `tests/integracao/atender.test.ts`
 *
 * O que sobra de modelo no caso 9 — responder ao conjunto e não só à última
 * fala — está coberto acima. Gastar token do modelo para reverificar timer e
 * UPDATE de status não acrescentaria nada.
 */
