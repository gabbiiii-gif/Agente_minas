import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { criarPool } from "./pool.js";
import { lerEnv } from "../config/env.js";

/**
 * Aplica os arquivos de seed em ordem alfabética.
 *
 * Os seeds são idempotentes (ON CONFLICT), então rodar de novo é seguro — é
 * assim que se corrige um sinônimo: edita o arquivo e roda de novo.
 * Depois de mexer em sinônimo é PRECISO reimportar o catálogo: a
 * descrição normalizada é gravada no import, não calculada na consulta.
 */
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

// Reexportado por compatibilidade: o lugar dele agora é `sinonimos.ts`, para
// a busca não depender deste arquivo — que lê disco, abre pool e tem bloco de
// CLI, coisas que a Edge Function não resolve.
export { carregarSinonimos } from "./sinonimos.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = criarPool(lerEnv().databaseUrl);
  await semear(pool);
  console.log("Seeds aplicados.");
  await pool.end();
}
