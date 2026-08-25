import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import { resolverContato } from "../../src/conversa/contatos.js";
import {
  conversaAtiva,
  gravarMensagem,
  ultimasMensagens,
  marcarStatus,
} from "../../src/conversa/historico.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

/**
 * O teste de idempotência é o mais importante daqui: o Evolution reenvia o
 * mesmo webhook quando não recebe 200 a tempo, e responder duas vezes à mesma
 * mensagem é o erro que o cliente percebe na hora.
 */
descrever("historico", () => {
  let pool: Pool;
  let contatoId: string;
  let conversaId: string;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await pool.query("delete from agente.contatos where telefone = '5593900000009'");
    contatoId = (await resolverContato(pool, "5593900000009", "Teste")).id;
    conversaId = (await conversaAtiva(pool, contatoId)).id;
  });

  afterAll(async () => {
    await pool.query("delete from agente.contatos where telefone = '5593900000009'");
    await pool.end();
  });

  it("reaproveita a conversa ativa em vez de abrir outra", async () => {
    const outra = await conversaAtiva(pool, contatoId);
    expect(outra.id).toBe(conversaId);
  });

  it("grava a mensagem do cliente", async () => {
    const id = await gravarMensagem(pool, {
      conversaId,
      papel: "cliente",
      conteudo: "tem retentor?",
      msgExtId: "EXT-1",
    });
    // Devolve o id, e não um booleano: é por ele que a foto se pendura.
    expect(id).not.toBeNull();
  });

  it("recusa o mesmo msg_ext_id — o evolution reenvia webhook", async () => {
    const id = await gravarMensagem(pool, {
      conversaId,
      papel: "cliente",
      conteudo: "tem retentor?",
      msgExtId: "EXT-1",
    });
    expect(id).toBeNull();
  });

  it("devolve as últimas mensagens em ordem cronológica", async () => {
    await gravarMensagem(pool, {
      conversaId,
      papel: "agente",
      conteudo: "Qual a moto?",
      msgExtId: "EXT-2",
    });
    const msgs = await ultimasMensagens(pool, conversaId, 12);
    expect(msgs.at(-1)!.conteudo).toBe("Qual a moto?");
    expect(msgs.at(-2)!.papel).toBe("cliente");
  });

  it("mantém a ordem mesmo quando as mensagens caem no mesmo instante", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into agente.conversas (contato_id) values ($1) returning id`,
      [contatoId],
    );
    const cid = rows[0]!.id;

    // Mesmo criado_em de propósito: sem desempate estável por id, a resposta
    // do agente apareceria antes da pergunta do cliente.
    await pool.query(
      `insert into agente.mensagens (conversa_id, papel, conteudo, criado_em) values
         ($1, 'cliente', 'primeira', '2026-08-20T12:00:00Z'),
         ($1, 'agente',  'segunda',  '2026-08-20T12:00:00Z')`,
      [cid],
    );

    const msgs = await ultimasMensagens(pool, cid, 12);
    expect(msgs.map((m) => m.conteudo)).toEqual(["primeira", "segunda"]);
  });

  it("limita a janela ao tamanho pedido", async () => {
    for (let i = 0; i < 15; i++) {
      await gravarMensagem(pool, {
        conversaId,
        papel: "cliente",
        conteudo: `m${i}`,
        msgExtId: `EXT-L${i}`,
      });
    }
    expect((await ultimasMensagens(pool, conversaId, 12)).length).toBe(12);
  });

  it("abre conversa nova depois que a anterior encerra", async () => {
    await marcarStatus(pool, conversaId, "encerrada", { desfecho: "qualificou" });
    const nova = await conversaAtiva(pool, contatoId);
    expect(nova.id).not.toBe(conversaId);
  });
});
