import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { carregarSinonimos, semear } from "../../src/db/semear.js";
import { expandir } from "../../src/catalogo/expandir.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("seeds", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = criarPool(url!);
    await semear(pool);
  });
  afterAll(async () => { await pool.end(); });

  it("carrega sinônimos do banco", async () => {
    const sinonimos = await carregarSinonimos(pool);
    expect(sinonimos.get("RET")).toBe("RETENTOR");
    expect(sinonimos.get("KIT RELACAO")).toBe("COROA TRANS");
  });

  it("expande a gíria do cliente com os sinônimos reais", async () => {
    const sinonimos = await carregarSinonimos(pool);
    expect(expandir("KIT RELACAO FAZER250", sinonimos)).toBe("COROA TRANS FAZER250");
    expect(expandir("RET DIANT TITAM", sinonimos)).toBe("RETENTOR DIANTEIRO TITAN");
  });

  it("acha moto por apelido", async () => {
    const { rows } = await pool.query<{ modelo: string }>(
      "select modelo from agente.motos where $1 = any(apelidos)",
      ["titam"],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.modelo).toBe("titan");
  });
});
