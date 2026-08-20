import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { criarPool } from "./pool.js";
import { lerEnv } from "../config/env.js";

const CONTROLE = `
  create schema if not exists agente;
  create table if not exists agente.migracoes (
    nome        text primary key,
    aplicada_em timestamptz not null default now()
  );
`;

/**
 * Aplica as migrações ainda não registradas, em ordem de nome de arquivo.
 *
 * Cada migração roda na própria transação e só é registrada se o arquivo
 * inteiro passar — migração que falha no meio não fica marcada como aplicada.
 * Migração já registrada é pulada, então rodar de novo é seguro.
 *
 * @returns os nomes aplicados nesta execução
 */
export async function aplicarMigracoes(
  pool: Pool,
  diretorio: string,
): Promise<string[]> {
  await pool.query(CONTROLE);

  const { rows } = await pool.query<{ nome: string }>(
    "select nome from agente.migracoes",
  );
  const jaAplicadas = new Set(rows.map((r) => r.nome));

  const arquivos = readdirSync(diretorio)
    .filter((n) => n.endsWith(".sql"))
    .sort();

  const aplicadas: string[] = [];

  for (const nome of arquivos) {
    if (jaAplicadas.has(nome)) continue;
    const sql = readFileSync(join(diretorio, nome), "utf8");
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      await cliente.query(sql);
      await cliente.query("insert into agente.migracoes (nome) values ($1)", [
        nome,
      ]);
      await cliente.query("commit");
      aplicadas.push(nome);
    } catch (erro) {
      await cliente.query("rollback");
      throw new Error(`Migração ${nome} falhou: ${(erro as Error).message}`);
    } finally {
      cliente.release();
    }
  }

  return aplicadas;
}

// No Windows process.argv[1] vem como C:... — comparar com `file://${argv}` nunca casa.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = lerEnv();
  const pool = criarPool(env.databaseUrl);
  const aplicadas = await aplicarMigracoes(pool, "supabase/migrations");
  console.log(
    aplicadas.length > 0
      ? `Aplicadas: ${aplicadas.join(", ")}`
      : "Nada novo para aplicar.",
  );
  await pool.end();
}
