import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { buscarPeca } from "../../src/busca/buscar.js";
import golden from "./golden-set.json" with { type: "json" };

const url = process.env.DATABASE_URL;
const descrever = url ? describe : describe.skip;

const META_RECALL_3 = 0.85;

descrever("recall do golden set", () => {
  let pool: Pool;
  beforeAll(() => { pool = criarPool(url!); });
  afterAll(async () => { await pool.end(); });

  it(`acerta pelo menos ${META_RECALL_3 * 100}% no topo 3`, async () => {
    let no1 = 0;
    let no3 = 0;
    const falhas: string[] = [];

    for (const caso of golden as Array<{ consulta: string; esperado: string[] }>) {
      const achados = await buscarPeca(pool, caso.consulta);
      const codigos = achados.map((a) => a.codigo);
      const acertou1 = codigos.length > 0 && caso.esperado.includes(codigos[0]!);
      const acertou3 = codigos.slice(0, 3).some((c) => caso.esperado.includes(c));
      if (acertou1) no1 += 1;
      if (acertou3) no3 += 1;
      else falhas.push(`${caso.consulta} → esperava ${caso.esperado.join("|")}, veio ${codigos.slice(0, 3).join("|") || "nada"}`);
    }

    const total = (golden as unknown[]).length;
    console.log(`recall@1 ${(no1 / total * 100).toFixed(1)}%  ·  recall@3 ${(no3 / total * 100).toFixed(1)}%`);
    if (falhas.length > 0) console.log("Falhas:\n" + falhas.join("\n"));

    expect(no3 / total).toBeGreaterThanOrEqual(META_RECALL_3);
  }, 60_000);
});
