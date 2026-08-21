import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import { resolverContato } from "../../src/conversa/contatos.js";
import { conversaAtiva, gravarMensagem } from "../../src/conversa/historico.js";
import { esperarVez } from "../../src/gateway/janela.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

const TEL = "5593922220001";

/** Espera instantânea: o que se testa aqui é a decisão, não o relógio. */
const semEsperar = async () => {};

/**
 * O debounce sem memória, que é o que permite rodar em serverless.
 *
 * O caso que importa é o de duas invocações concorrentes: sem elas
 * combinarem pelo banco, o cliente que escreve em três mensagens recebe três
 * respostas — que é exatamente o que o debounce existe para evitar.
 */
descrever("esperarVez", () => {
  let pool: Pool;
  let conversaId: string;
  let n = 0;

  const novaMensagem = async () => {
    n += 1;
    await gravarMensagem(pool, {
      conversaId,
      papel: "cliente",
      conteudo: `mensagem ${n}`,
      msgExtId: `JAN-${n}-${Date.now()}`,
    });
  };

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
  });

  afterAll(async () => {
    await pool.query("delete from agente.contatos where telefone = $1", [TEL]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("delete from agente.contatos where telefone = $1", [TEL]);
    const contato = await resolverContato(pool, TEL, "Teste");
    conversaId = (await conversaAtiva(pool, contato.id)).id;
    await novaMensagem();
  });

  it("assume o turno quando ninguém escreveu durante a janela", async () => {
    expect(await esperarVez(pool, conversaId, 0, semEsperar)).toBe(true);
  });

  it("desiste quando chega mensagem nova durante a janela", async () => {
    // O cliente continuou digitando: quem responde é a invocação da última
    // mensagem, não esta.
    const desiste = await esperarVez(pool, conversaId, 0, novaMensagem);
    expect(desiste).toBe(false);
  });

  it("de duas invocações concorrentes, só a mais nova responde", async () => {
    const primeira = esperarVez(pool, conversaId, 0, async () => {
      // Enquanto a primeira dorme, chega outra mensagem e sobe outra invocação.
      await novaMensagem();
      segunda = esperarVez(pool, conversaId, 0, semEsperar);
      await segunda;
    });

    let segunda: Promise<boolean> = Promise.resolve(false);
    const resultadoPrimeira = await primeira;

    expect(resultadoPrimeira).toBe(false);
    expect(await segunda).toBe(true);
  });

  it("não responde conversa que não existe", async () => {
    const inexistente = "00000000-0000-0000-0000-000000000000";
    expect(await esperarVez(pool, inexistente, 0, semEsperar)).toBe(false);
  });

  it("espera de verdade o tempo pedido", async () => {
    const inicio = Date.now();
    await esperarVez(pool, conversaId, 120);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(110);
  });
});
