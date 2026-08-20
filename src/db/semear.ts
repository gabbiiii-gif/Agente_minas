import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import type { Sinonimos } from "../catalogo/expandir.js";
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

/**
 * Carrega a tabela de sinônimos no formato que `expandir` consome.
 *
 * Usado pelo importador (para gravar a descrição normalizada) e pela busca
 * (para tratar a frase do cliente). Os dois lados precisam do MESMO mapa,
 * senão a consulta e o catálogo divergem e a busca não acha nada.
 */
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
