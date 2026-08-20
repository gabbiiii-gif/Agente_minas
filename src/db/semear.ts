import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import type { Sinonimos } from "../catalogo/expandir.js";
import { criarPool } from "./pool.js";
import { lerEnv } from "../config/env.js";

export async function semear(
  pool: Pool,
  diretorio = "supabase/seeds",
): Promise<void> {
  for (const nome of readdirSync(diretorio)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await pool.query(readFileSync(join(diretorio, nome), "utf8"));
  }
}

export async function carregarSinonimos(pool: Pool): Promise<Sinonimos> {
  const { rows } = await pool.query<{ termo: string; canonico: string }>(
    "select termo, canonico from agente.sinonimos",
  );
  return new Map(rows.map((r) => [r.termo, r.canonico]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = criarPool(lerEnv().databaseUrl);
  await semear(pool);
  console.log("Seeds aplicados.");
  await pool.end();
}
