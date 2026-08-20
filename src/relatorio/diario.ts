// Relatório diário da demanda que a loja não atendeu.
//
// Roda pelo cron do host, não por timer dentro do gateway: o relatório é
// independente do serviço de conversa e não deve morrer junto com ele.
//
//   0 7 * * * cd /opt/minas-agente && npm run relatorio:diario >> /var/log/minas-relatorio.log 2>&1
import type { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { criarPool } from "../db/pool.js";
import { lerEnvGateway } from "../config/env.js";
import { enviar, type ConfigEvolution } from "../saida/evolution.js";

export interface LinhaDemanda {
  /** Peça em nome padronizado. null quando o agente não conseguiu normalizar. */
  peca: string | null;
  /** Moto do cliente, montada para leitura. null quando ele não disse. */
  moto: string | null;
  pedidos: number;
}

/** Quantas linhas cabem numa mensagem que o dono lê no balcão sem rolar muito. */
const MAX_LINHAS = 20;

/**
 * O que os clientes pediram e a loja não tinha, agrupado.
 *
 * É a lista de compra do dono baseada em demanda real — o retorno comercial
 * do projeto. Vale mais que qualquer métrica de atendimento: dez pessoas
 * pedindo a mesma peça no mês é uma decisão de estoque.
 */
export async function levantarDemanda(pool: Pool, horas = 24): Promise<LinhaDemanda[]> {
  const { rows } = await pool.query(
    `select d.peca_norm, m.marca, m.modelo, m.cilindrada, count(*)::text as pedidos
       from agente.demanda_nao_atendida d
       left join agente.motos m on m.id = d.moto_id
      where d.criado_em > now() - make_interval(hours => $1::int)
      group by 1,2,3,4
      order by count(*) desc, d.peca_norm
      limit ${MAX_LINHAS}`,
    [horas],
  );

  return rows.map((r) => ({
    peca: r.peca_norm,
    moto: r.modelo ? `${r.marca} ${r.modelo} ${r.cilindrada ?? ""}`.trim() : null,
    pedidos: Number(r.pedidos),
  }));
}

/**
 * Monta a mensagem, ou null quando não há o que contar.
 *
 * null é resposta legítima e importante: relatório vazio chegando todo dia
 * treina o dono a ignorar a mensagem, e aí o dia que tiver conteúdo passa
 * batido também.
 */
export function montarTexto(linhas: LinhaDemanda[], horas = 24): string | null {
  if (linhas.length === 0) return null;

  const itens = linhas.map((l) => {
    const peca = (l.peca ?? "peça não identificada").toLowerCase();
    const moto = l.moto ?? "moto não informada";
    return `${l.pedidos}× ${peca} — ${moto}`;
  });

  // Uma quebra só entre cabeçalho e lista, nunca duas: linha em branco é
  // separador de parágrafo para o `dividir`, e o relatório chegaria partido
  // em duas mensagens. Sem parágrafo e sem ponto final, a lista inteira sai
  // junta por mais longa que fique.
  return [
    `Peças que os clientes pediram nas últimas ${horas}h e a loja não tinha:`,
    ...itens,
  ].join("\n");
}

/**
 * Levanta e manda para o dono. Devolve se mandou alguma coisa.
 *
 * Vai só para o `telefoneDono` — este relatório tem número de demanda da
 * loja e não pode escapar para cliente nenhum.
 */
export async function enviarRelatorio(
  pool: Pool,
  evolution: ConfigEvolution,
  telefoneDono: string | null,
  horas = 24,
): Promise<boolean> {
  const texto = montarTexto(await levantarDemanda(pool, horas), horas);
  if (texto === null) {
    console.log("sem demanda nas últimas 24h; nada a enviar");
    return false;
  }

  if (!telefoneDono) {
    console.log("TELEFONE_DONO não configurado; relatório não enviado:\n" + texto);
    return false;
  }

  await enviar(pool, evolution, telefoneDono, texto);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = lerEnvGateway();
  const pool = criarPool(env.databaseUrl);
  try {
    await enviarRelatorio(
      pool,
      {
        url: env.evolutionUrl,
        apiKey: env.evolutionApiKey,
        instancia: env.evolutionInstancia,
      },
      env.telefoneDono,
    );
  } finally {
    await pool.end();
  }
}
