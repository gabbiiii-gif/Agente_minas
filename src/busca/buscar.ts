import type { Pool } from "pg";
import { normalizar } from "../catalogo/normalizar.js";
import { expandir } from "../catalogo/expandir.js";
import { carregarSinonimos } from "../db/sinonimos.js";
import type { Sinonimos } from "../catalogo/expandir.js";

/** Uma peça encontrada. Note que não existe preço: o ERP não exporta valor. */
export interface Achado {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  estoque: number;
  /** 'humano' = balcão confirmou. Só ele autoriza afirmar que a peça serve. */
  fitment: "humano" | "auto" | "nenhum";
  /** Dias desde a última atualização do produto; estoque velho é suspeito. */
  diasSemAtualizar: number;
  score: number;
}

/**
 * Os sinônimos mudam só quando alguém roda o seed, então carregar uma vez por
 * processo evita um SELECT por mensagem de cliente.
 */
let cache: Sinonimos | null = null;

/** Só dígitos e curto o bastante para ser código do ERP, não medida de peça. */
const SO_DIGITOS = /^\d{1,7}$/;

/**
 * Palavras de ligação que o cliente escreve ("retentor DE pinhão DA falcon")
 * e o catálogo do ERP nunca tem. Se ficarem, a cobertura de palavras da
 * consulta é diluída por termos que jamais vão casar.
 */
const LIGACAO = new Set([
  "DE", "DA", "DO", "DAS", "DOS", "E", "PARA", "PRA", "COM", "A", "O", "EM", "NO", "NA",
]);

function tirarLigacao(texto: string): string {
  const restante = texto.split(" ").filter((t) => t !== "" && !LIGACAO.has(t));
  // "kit de e para" não pode virar consulta vazia — melhor buscar o original.
  return restante.length > 0 ? restante.join(" ") : texto;
}

/**
 * Busca peça no catálogo. É o único meio autorizado de afirmar que a loja tem
 * alguma coisa — o agente nunca deduz disponibilidade por conta própria.
 *
 * O texto do cliente passa pela mesma normalização e expansão aplicadas às
 * descrições no import, para que os dois vocabulários se encontrem.
 *
 * @param texto  o que o cliente escreveu, cru
 * @param motoId moto do contato, quando conhecida: ordena por compatibilidade
 */
export async function buscarPeca(
  pool: Pool,
  texto: string,
  motoId: string | null = null,
): Promise<Achado[]> {
  cache ??= await carregarSinonimos(pool);

  const norm = normalizar(texto);
  if (norm === "") return [];

  const textoNorm = tirarLigacao(expandir(norm, cache));
  // Cliente que manda "4402" está passando o código da peça velha, não texto.
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
