import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("aplicarMigracoes", () => {
  let pool: Pool;
  let dir: string;

  beforeAll(async () => {
    pool = criarPool(url!);
    dir = mkdtempSync(join(tmpdir(), "migr-"));
    writeFileSync(
      join(dir, "9001_teste.sql"),
      "create table if not exists teste_migracao (id int);",
    );
    await pool.query("drop table if exists teste_migracao");
    await pool
      .query("delete from agente.migracoes where nome = '9001_teste.sql'")
      .catch(() => {});
  });

  afterAll(async () => {
    await pool.query("drop table if exists teste_migracao");
    await pool.query("delete from agente.migracoes where nome = '9001_teste.sql'");
    await pool.end();
  });

  it("aplica migração nova e registra", async () => {
    const aplicadas = await aplicarMigracoes(pool, dir);
    expect(aplicadas).toContain("9001_teste.sql");
  });

  it("não reaplica migração já registrada", async () => {
    const aplicadas = await aplicarMigracoes(pool, dir);
    expect(aplicadas).toEqual([]);
  });
});
