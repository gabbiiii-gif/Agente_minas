import type { Pool } from "pg";
import type { Sinonimos } from "../catalogo/expandir.js";

/**
 * Carrega o mapa de sinônimos do banco.
 *
 * Usado pelo importador (para gravar a descrição normalizada) e pela busca
 * (para tratar a frase do cliente). Os dois lados precisam do MESMO mapa,
 * senão a consulta e o catálogo divergem e a busca não acha nada.
 *
 * Mora aqui, e não em `semear.ts`, porque a busca não pode depender do
 * semeador: ele lê arquivo, abre pool e tem bloco de CLI, e isso arrastava
 * `pg` e `node:fs` para dentro do grafo da Edge Function, que não resolve
 * nenhum dos dois.
 */
export async function carregarSinonimos(pool: Pool): Promise<Sinonimos> {
  const { rows } = await pool.query<{ termo: string; canonico: string }>(
    "select termo, canonico from agente.sinonimos",
  );
  return new Map(rows.map((r) => [r.termo, r.canonico]));
}
