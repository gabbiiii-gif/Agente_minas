import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import {
  resolverContato,
  estaSilenciado,
  silenciarPorHumano,
  contatosNovosNaUltimaHora,
} from "../../src/conversa/contatos.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

/**
 * Contra o Postgres local descartável, não contra o Supabase: estes testes
 * escrevem em `agente.contatos`, e o prefixo 55939000 é a faixa reservada
 * para eles — o beforeAll e o afterAll limpam só ela.
 */
descrever("contatos", () => {
  let pool: Pool;
  const tel = "5593900000001";

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await pool.query("delete from agente.contatos where telefone like '55939000%'");
  });

  afterAll(async () => {
    await pool.query("delete from agente.contatos where telefone like '55939000%'");
    await pool.end();
  });

  it("cria o contato no primeiro contato e reaproveita depois", async () => {
    const a = await resolverContato(pool, tel, "Zé");
    const b = await resolverContato(pool, tel, "Zé da Moto");
    expect(b.id).toBe(a.id);
  });

  it("não apaga o nome quando o pushName vem vazio", async () => {
    await resolverContato(pool, tel, "Zé");
    const c = await resolverContato(pool, tel, "");
    expect(c.nome).toBe("Zé");
  });

  it("silencia por 6 horas quando o balcão responde", async () => {
    const c = await resolverContato(pool, tel, "Zé");
    const agora = new Date("2026-08-20T12:00:00Z");
    await silenciarPorHumano(pool, c.id, agora);

    const depois = await resolverContato(pool, tel, "Zé");
    expect(estaSilenciado(depois, new Date("2026-08-20T17:59:00Z"))).toBe(true);
    expect(estaSilenciado(depois, new Date("2026-08-20T18:01:00Z"))).toBe(false);
  });

  it("conta contatos novos da última hora para o teto anti-banimento", async () => {
    const antes = await contatosNovosNaUltimaHora(pool);
    await resolverContato(pool, "5593900000002", "Novo");
    expect(await contatosNovosNaUltimaHora(pool)).toBe(antes + 1);
  });
});
