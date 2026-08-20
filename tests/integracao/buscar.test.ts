import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { buscarPeca } from "../../src/busca/buscar.js";

const url = process.env.DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("buscarPeca", () => {
  let pool: Pool;
  beforeAll(() => { pool = criarPool(url!); });
  afterAll(async () => { await pool.end(); });

  it("acha por código exato com score máximo", async () => {
    const achados = await buscarPeca(pool, "2399");
    expect(achados[0]!.codigo).toBe("2399");
    expect(achados[0]!.score).toBe(1);
  });

  it("devolve no máximo 8 resultados", async () => {
    const achados = await buscarPeca(pool, "titan");
    expect(achados.length).toBeLessThanOrEqual(8);
  });

  it("devolve lista vazia para coisa que a loja não vende", async () => {
    const achados = await buscarPeca(pool, "geladeira brastemp duplex");
    expect(achados).toEqual([]);
  });

  it("traz dias sem atualizar para o agente decidir se afirma quantidade", async () => {
    const achados = await buscarPeca(pool, "2399");
    expect(achados[0]!.diasSemAtualizar).toBeGreaterThanOrEqual(0);
    expect(achados[0]!.fitment).toBe("nenhum");
  });
});
