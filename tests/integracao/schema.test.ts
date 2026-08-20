import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("schema agente", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("cria todas as tabelas previstas", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'agente'",
    );
    const nomes = rows.map((r) => r.table_name);
    for (const esperada of [
      "produtos", "motos", "produto_moto", "sinonimos",
      "contatos", "conversas", "mensagens", "demanda_nao_atendida",
      "config", "saidas_pendentes",
    ]) {
      expect(nomes).toContain(esperada);
    }
  });

  it("não tem nenhuma coluna de preço em lugar nenhum", async () => {
    // agente.config é um par chave/valor de configuração — o "valor" ali é o
    // conteúdo jsonb da chave, não dinheiro. É a única exceção permitida.
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns
       where table_schema = 'agente'
         and (column_name ilike '%preco%' or column_name ilike '%valor%')
         and not (table_name = 'config' and column_name = 'valor')`,
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("habilita pg_trgm e unaccent", async () => {
    const { rows } = await pool.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('pg_trgm','unaccent')",
    );
    expect(rows.map((r) => r.extname).sort()).toEqual(["pg_trgm", "unaccent"]);
  });
});
