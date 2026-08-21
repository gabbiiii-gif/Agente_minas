import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Pool } from "pg";

/** Um modelo de moto citado numa descrição de peça. */
export interface ModeloExtraido {
  modelo: string;
  /** null quando a descrição não diz a cilindrada ("TITAN" sem número). */
  cilindrada: number | null;
}

/** Linha de `agente.motos` — a frota que a loja atende. */
export interface LinhaMoto {
  id: string;
  marca: string;
  modelo: string;
  cilindrada: number | null;
}

// Haiku dá conta desta tarefa e custa uma fração do Sonnet: é extração
// mecânica de nome de modelo, roda uma vez sobre o catálogo inteiro.
const MODELO_HAIKU = "claude-haiku-4-5";

// 40 descrições por chamada: lote maior estoura o teto de saída e um lote
// perdido custa mais do que a economia de chamadas.
const LOTE = 40;

// Quantos lotes em voo ao mesmo tempo. Sequencial levaria ~10 min para o
// catálogo inteiro; acima de 4 começa a esbarrar em rate limit.
const CONCORRENCIA = 4;

/**
 * Formato de resposta exigido do modelo. Com saída estruturada o SDK valida
 * contra este schema — sem ele, um JSON malformado descartaria as 40 peças
 * do lote em silêncio.
 */
const RespostaLote = z.object({
  itens: z.array(
    z.object({
      i: z.number().int(),
      modelos: z.array(
        z.object({
          modelo: z.string(),
          cilindrada: z.number().int().nullable(),
        }),
      ),
    }),
  ),
});

const INSTRUCAO = `Você recebe descrições de peças de moto de uma loja brasileira.
Para cada descrição, extraia os modelos de moto em que a peça se aplica.

Regras:
- Modelo em minúsculas, sem cilindrada junto: "TITAN 150" vira {"modelo":"titan","cilindrada":150}.
- Barra separa modelos: "TITAN/XLR/XR" são três modelos distintos.
- Sufixo de versão não faz parte do modelo: ES, ESD, KS, EX, CDI, FLEX, START e ADV
  são acabamentos. "TITAN ES" vira {"modelo":"titan","cilindrada":null}. O catálogo
  de motos guarda só o modelo base, então versão junto não casa com nada e a peça
  fica sem compatibilidade nenhuma.
- Sem cilindrada explícita, use null.
- Nome de fabricante da peça (FORTUNA, VEDAMOTORS, NGK, FABRECK, COSER, MHX, SCT) não é modelo de moto.
- Peça universal, sem modelo nenhum, devolve lista vazia.
- O campo "i" é o índice da descrição na lista recebida. Devolva um item por descrição.`;

/**
 * Lê as descrições em lote e devolve, por descrição, os modelos citados.
 *
 * Um lote que falhar é registrado e pulado — o import continua, e as peças
 * daquele lote simplesmente ficam sem fitment (o que a busca tolera, já que
 * fitment ordena mas não filtra).
 */
export async function extrairModelos(
  descricoes: string[],
  apiKey: string,
  /**
   * Com `true`, relança o erro do lote em vez de seguir sem ele. O import em
   * lote quer tolerância (perder 40 peças não justifica abortar 5.232); o
   * teste quer saber exatamente por que falhou.
   */
  estrito = false,
): Promise<Map<string, ModeloExtraido[]>> {
  const cliente = new Anthropic({ apiKey });
  const saida = new Map<string, ModeloExtraido[]>();

  const lotes: string[][] = [];
  for (let i = 0; i < descricoes.length; i += LOTE) {
    lotes.push(descricoes.slice(i, i + LOTE));
  }

  // Processa CONCORRENCIA lotes por vez, preservando a ordem de leitura.
  for (let i = 0; i < lotes.length; i += CONCORRENCIA) {
    const bloco = lotes.slice(i, i + CONCORRENCIA);
    const resultados = await Promise.all(
      bloco.map(async (lote, n) => {
        try {
          const resposta = await cliente.messages.parse({
            model: MODELO_HAIKU,
            max_tokens: 8000,
            system: INSTRUCAO,
            messages: [
              { role: "user", content: lote.map((d, k) => `${k}: ${d}`).join("\n") },
            ],
            output_config: { format: zodOutputFormat(RespostaLote) },
          });
          return { lote, itens: resposta.parsed_output?.itens ?? [] };
        } catch (erro) {
          if (estrito) throw erro;
          console.warn(
            `Lote ${i + n} falhou (${(erro as Error).message}); as peças dele ficam sem fitment.`,
          );
          return { lote, itens: [] };
        }
      }),
    );

    for (const { lote, itens } of resultados) {
      for (const item of itens) {
        const descricao = lote[item.i];
        if (descricao !== undefined) saida.set(descricao, item.modelos);
      }
    }
    console.log(`  fitment: ${Math.min(i + CONCORRENCIA, lotes.length)}/${lotes.length} lotes`);
  }

  return saida;
}

/**
 * Converte os modelos extraídos em ids de `agente.motos`.
 *
 * Função pura, sem rede — é onde mora a regra de negócio, então é o pedaço
 * que tem teste unitário. Modelo que não está na frota cadastrada é
 * descartado: melhor não ter fitment do que ter fitment errado.
 */
export function casarComFrota(
  extraidos: ModeloExtraido[],
  frota: LinhaMoto[],
): string[] {
  const ids = new Set<string>();
  for (const e of extraidos) {
    for (const moto of frota) {
      if (moto.modelo !== e.modelo) continue;
      // Sem cilindrada na descrição, a peça vale para todas as cilindradas
      // daquele modelo — é o que "PISTAO TITAN" significa no catálogo.
      if (e.cilindrada !== null && moto.cilindrada !== e.cilindrada) continue;
      ids.add(moto.id);
    }
  }
  return [...ids];
}

/**
 * Preenche `agente.produto_moto` com origem 'auto' para todo o catálogo.
 *
 * ATENÇÃO: origem 'auto' NUNCA autoriza o agente a afirmar que a peça serve.
 * É pista de ordenação. Só 'humano' — preenchido pelo balcão — libera
 * "serve sim". Compatibilidade afirmada errado gera devolução e frete.
 */
export async function popularFitment(
  pool: Pool,
  apiKey: string,
  /**
   * Por padrão processa só quem ainda não passou pela extração. Passe `false`
   * para reprocessar o catálogo inteiro — necessário depois de mexer no seed
   * de motos, que muda o resultado do casamento.
   */
  apenasPendentes = true,
): Promise<{ produtos: number; vinculos: number; semCasar: number }> {
  const { rows: frota } = await pool.query<LinhaMoto>(
    "select id, marca, modelo, cilindrada from agente.motos",
  );
  const { rows: produtos } = await pool.query<{ id: string; descricao: string }>(
    `select id, descricao from agente.produtos
      where ativo ${apenasPendentes ? "and fitment_em is null" : ""}`,
  );

  if (produtos.length === 0) {
    return { produtos: 0, vinculos: 0, semCasar: 0 };
  }

  const extraidos = await extrairModelos(
    produtos.map((p) => p.descricao),
    apiKey,
  );

  // Monta todos os vínculos primeiro e grava em lote: um INSERT por vínculo
  // seriam ~9.000 idas ao banco.
  const paresProduto: string[] = [];
  const paresMoto: string[] = [];
  // Só marca como processado quem o modelo realmente respondeu. Produto de
  // lote que falhou fica sem marca e entra na próxima execução.
  const processados: string[] = [];
  let semCasar = 0;

  for (const produto of produtos) {
    const modelos = extraidos.get(produto.descricao);
    if (modelos === undefined) continue;
    processados.push(produto.id);

    const motoIds = casarComFrota(modelos, frota);
    if (motoIds.length === 0) {
      semCasar += 1;
      continue;
    }
    for (const motoId of motoIds) {
      paresProduto.push(produto.id);
      paresMoto.push(motoId);
    }
  }

  const LOTE_INSERT = 1000;
  for (let i = 0; i < paresProduto.length; i += LOTE_INSERT) {
    await pool.query(
      `insert into agente.produto_moto (produto_id, moto_id, origem, confianca)
       select unnest($1::uuid[]), unnest($2::uuid[]), 'auto', 0.7
       on conflict (produto_id, moto_id) do nothing`,
      [
        paresProduto.slice(i, i + LOTE_INSERT),
        paresMoto.slice(i, i + LOTE_INSERT),
      ],
    );
  }

  for (let i = 0; i < processados.length; i += LOTE_INSERT) {
    await pool.query(
      `update agente.produtos set fitment_em = now()
        where id = any($1::uuid[])`,
      [processados.slice(i, i + LOTE_INSERT)],
    );
  }

  return { produtos: processados.length, vinculos: paresProduto.length, semCasar };
}
