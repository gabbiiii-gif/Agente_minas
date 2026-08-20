import type { Pool } from "pg";
import { normalizar } from "../catalogo/normalizar.js";
import { expandir } from "../catalogo/expandir.js";
import { carregarSinonimos } from "../db/semear.js";
import type { Sinonimos } from "../catalogo/expandir.js";

export interface Achado {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  estoque: number;
  fitment: "humano" | "auto" | "nenhum";
  diasSemAtualizar: number;
  score: number;
}

let cache: Sinonimos | null = null;

const SO_DIGITOS = /^\d{1,7}$/;

export async function buscarPeca(
  pool: Pool,
  texto: string,
  motoId: string | null = null,
): Promise<Achado[]> {
  cache ??= await carregarSinonimos(pool);

  const norm = normalizar(texto);
  if (norm === "") return [];

  const textoNorm = expandir(norm, cache);
  const codigo = SO_DIGITOS.test(norm) ? norm : null;

  const { rows } = await pool.query(
    "select * from agente.buscar_peca($1, $2, $3)",
    [textoNorm, codigo, motoId],
  );

  return rows.map((r) => ({
    id: r.id,
    codigo: r.codigo,
    descricao: r.descricao,
    unidade: r.unidade,
    estoque: r.estoque,
    fitment: r.fitment,
    diasSemAtualizar: r.dias_sem_atualizar,
    score: r.score,
  }));
}
