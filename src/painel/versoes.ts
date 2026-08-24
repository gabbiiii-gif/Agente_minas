import type { Pool } from "pg";
import {
  lerConfig,
  gravarConfig,
  promptEfetivo,
  modeloConhecido,
  type ConfigLoja,
} from "../config/loja.js";

/**
 * Versões do agente: o que ele era em cada momento, e como voltar.
 *
 * "Versão" aqui é o par que decide o comportamento do atendimento — o modelo
 * que responde e as instruções que ele segue. Sem isto, mudar o prompt era um
 * caminho só de ida: quem editasse um parágrafo e piorasse o atendimento não
 * tinha para onde voltar, e a única evidência de que algo mudou era a
 * reclamação do cliente três dias depois.
 *
 * O texto vai guardado inteiro, não como diferença: um prompt tem uns 6 KB, e
 * reconstruir por diff para restaurar sob pressão é justamente o que ninguém
 * quer estar fazendo quando o atendimento está ruim.
 */

export interface VersaoAgente {
  id: number;
  numero: number;
  modelo: string;
  /** null = a versão usava o prompt padrão do código. */
  prompt: string | null;
  nota: string | null;
  publicadaEm: string;
  publicadaPor: string;
  /** true quando é exatamente o que está no ar agora. */
  emUso: boolean;
}

export async function listarVersoes(pool: Pool, limite = 30): Promise<VersaoAgente[]> {
  const cfg = await lerConfig(pool, false);
  const { rows } = await pool.query(
    `select id, numero, modelo, prompt, nota, publicada_em, publicada_por
       from agente.agente_versoes
      order by numero desc
      limit $1`,
    [limite],
  );

  return rows.map((r) => ({
    id: Number(r.id),
    numero: Number(r.numero),
    modelo: r.modelo,
    prompt: r.prompt,
    nota: r.nota,
    publicadaEm: r.publicada_em,
    publicadaPor: r.publicada_por,
    emUso: r.modelo === cfg.modeloConversa && (r.prompt ?? null) === cfg.promptCustomizado,
  }));
}

/**
 * Congela o que está no ar como uma versão numerada.
 *
 * Chamada depois de gravar a configuração, não antes: o que vira versão é o
 * estado que o cliente já está recebendo. Publicar antes criaria um número
 * para algo que a validação ainda podia recusar.
 */
export async function publicarVersao(
  pool: Pool,
  cfg: ConfigLoja,
  nota: string | null,
): Promise<VersaoAgente> {
  const { rows } = await pool.query<{ id: string; numero: number; publicada_em: string }>(
    `insert into agente.agente_versoes (numero, modelo, prompt, nota)
     values (
       coalesce((select max(numero) from agente.agente_versoes), 0) + 1,
       $1, $2, $3
     )
     returning id, numero, publicada_em`,
    [cfg.modeloConversa, cfg.promptCustomizado, nota?.trim() || null],
  );

  const r = rows[0]!;
  return {
    id: Number(r.id),
    numero: r.numero,
    modelo: cfg.modeloConversa,
    prompt: cfg.promptCustomizado,
    nota: nota?.trim() || null,
    publicadaEm: r.publicada_em,
    publicadaPor: "painel",
    emUso: true,
  };
}

/**
 * Volta o agente para uma versão anterior.
 *
 * Restaurar não apaga o histórico nem cria uma versão nova: ele só reaponta a
 * configuração. O histórico é a linha do tempo do que já foi publicado, e
 * reescrevê-la a cada volta atrás tiraria dela a única serventia que tem.
 */
export async function restaurarVersao(
  pool: Pool,
  numero: number,
): Promise<{ ok: true; versao: number } | { erro: string }> {
  const { rows } = await pool.query<{ modelo: string; prompt: string | null }>(
    "select modelo, prompt from agente.agente_versoes where numero = $1",
    [numero],
  );
  const v = rows[0];
  if (!v) return { erro: `versão ${numero} não existe` };
  if (!modeloConhecido(v.modelo)) {
    return { erro: `a versão ${numero} usa o modelo ${v.modelo}, que não está mais disponível` };
  }

  await gravarConfig(pool, { modeloConversa: v.modelo, promptCustomizado: v.prompt });
  await registrar(pool, "restaurar_versao", { numero });
  return { ok: true, versao: numero };
}

/**
 * Diferença entre uma versão e o que está no ar, em linhas.
 *
 * Comparação por linha, e não por palavra: o prompt é escrito em blocos com
 * títulos, e a pergunta que o dono faz olhando isto é sempre "qual regra
 * mudou", nunca "qual palavra mudou".
 */
export async function compararVersao(
  pool: Pool,
  numero: number,
): Promise<{ linhas: { sinal: " " | "-" | "+"; texto: string }[] } | { erro: string }> {
  const { rows } = await pool.query<{ modelo: string; prompt: string | null }>(
    "select modelo, prompt from agente.agente_versoes where numero = $1",
    [numero],
  );
  const v = rows[0];
  if (!v) return { erro: `versão ${numero} não existe` };

  const cfg = await lerConfig(pool, false);
  const antes = (v.prompt ?? promptEfetivo({ ...cfg, promptCustomizado: null })).split("\n");
  const depois = promptEfetivo(cfg).split("\n");

  return { linhas: diferenca(antes, depois) };
}

/**
 * Diferença de linhas pela maior subsequência comum.
 *
 * Escrito à mão porque a alternativa era uma dependência inteira para
 * comparar dois textos de 200 linhas, uma vez por clique.
 */
function diferenca(a: string[], b: string[]): { sinal: " " | "-" | "+"; texto: string }[] {
  const n = a.length;
  const m = b.length;
  const tabela: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      tabela[i]![j] =
        a[i] === b[j] ? tabela[i + 1]![j + 1]! + 1 : Math.max(tabela[i + 1]![j]!, tabela[i]![j + 1]!);
    }
  }

  const saida: { sinal: " " | "-" | "+"; texto: string }[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      saida.push({ sinal: " ", texto: a[i]! });
      i++;
      j++;
    } else if (tabela[i + 1]![j]! >= tabela[i]![j + 1]!) {
      saida.push({ sinal: "-", texto: a[i]! });
      i++;
    } else {
      saida.push({ sinal: "+", texto: b[j]! });
      j++;
    }
  }
  while (i < n) saida.push({ sinal: "-", texto: a[i++]! });
  while (j < m) saida.push({ sinal: "+", texto: b[j++]! });

  return saida;
}

/**
 * Anota uma ação do painel.
 *
 * "Quem desligou o bot na quinta às três da tarde?" não tinha resposta antes
 * disto. Nunca lança: perder o registro é ruim, mas derrubar a ação que o
 * dono acabou de pedir é pior.
 */
export async function registrar(
  pool: Pool,
  acao: string,
  detalhe?: unknown,
): Promise<void> {
  try {
    await pool.query(
      "insert into agente.painel_log (acao, detalhe) values ($1, $2::jsonb)",
      [acao, JSON.stringify(detalhe ?? null)],
    );
  } catch {
    // Sem log a vida segue.
  }
}

export async function listarLog(pool: Pool, limite = 40) {
  const { rows } = await pool.query(
    "select acao, detalhe, criado_em from agente.painel_log order by criado_em desc limit $1",
    [limite],
  );
  return rows.map((r) => ({ acao: r.acao, detalhe: r.detalhe, criadoEm: r.criado_em }));
}
