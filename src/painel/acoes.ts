import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { criarPool } from "../db/pool.js";
import {
  lerConfig,
  gravarConfig,
  promptPadrao,
  promptEfetivo,
  type ConfigLoja,
} from "../config/loja.js";
import { montarContexto } from "../agente/prompt.js";
import { responder, type Fala } from "../agente/laco.js";
import { executarFerramenta } from "../ferramentas/executar.js";

/**
 * O que o painel faz, separado de como ele é servido.
 *
 * As mesmas funções atendem o Fastify local e as funções serverless da
 * Vercel — sem isto, cada endpoint existiria duas vezes e as duas cópias
 * divergiriam na primeira correção.
 */

/**
 * Pool reaproveitado entre invocações.
 *
 * Em serverless o módulo sobrevive entre requisições da mesma instância
 * quente; criar um Pool por requisição esgotaria as conexões do Supabase em
 * minutos. O `globalThis` garante um só mesmo quando o bundler duplica o
 * módulo.
 */
const chaveGlobal = Symbol.for("minas.painel.pool");
type ComPool = typeof globalThis & { [chaveGlobal]?: Pool };

export function obterPool(): Pool {
  const g = globalThis as ComPool;
  if (!g[chaveGlobal]) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não configurada");
    g[chaveGlobal] = criarPool(url);
  }
  return g[chaveGlobal];
}

export function obterAnthropic(): Anthropic {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) throw new Error("ANTHROPIC_API_KEY não configurada");
  return new Anthropic({ apiKey: chave, maxRetries: 2 });
}

export async function acaoLerConfig(pool: Pool) {
  const cfg = await lerConfig(pool, false);
  return { ...cfg, promptPadrao: promptPadrao(cfg) };
}

/** Valida antes de gravar: o painel não pode salvar algo que derrube o agente. */
export async function acaoGravarConfig(
  pool: Pool,
  c: Partial<ConfigLoja>,
): Promise<{ ok: true } | { erro: string }> {
  if (c.tetoContatosNovosHora !== undefined && !(c.tetoContatosNovosHora > 0)) {
    return { erro: "teto de contatos novos precisa ser maior que zero" };
  }
  if (c.maxMensagensConversa !== undefined && !(c.maxMensagensConversa >= 5)) {
    return { erro: "limite de mensagens precisa ser pelo menos 5" };
  }
  if (
    c.promptCustomizado !== undefined &&
    c.promptCustomizado !== null &&
    c.promptCustomizado.trim().length < 200
  ) {
    return { erro: "instruções curtas demais — se quer voltar ao padrão, use o botão Restaurar" };
  }
  await gravarConfig(pool, c);
  return { ok: true };
}

/** Uma linha da lista de conversas. */
export interface ItemConversa {
  id: string;
  nome: string | null;
  telefone: string;
  ultimaMsgEm: string;
  status: string;
  desfecho: string | null;
  resumo: string | null;
  /** false quando o balcão assumiu — é o que pinta "Aguarda admin". */
  iaAtiva: boolean;
  mensagens: number;
}

/**
 * Lista as conversas, mais recente primeiro.
 *
 * `busca` casa nome e telefone: o balcão procura pelo nome que aparece no
 * WhatsApp ou pelo número, nunca pelo id.
 */
export async function acaoListarConversas(
  pool: Pool,
  busca = "",
  limite = 200,
): Promise<ItemConversa[]> {
  const termo = busca.trim();
  const { rows } = await pool.query(
    `select c.id,
            ct.nome,
            ct.telefone,
            c.ultima_msg_em,
            c.status,
            c.desfecho,
            c.resumo,
            ct.silenciado_ate,
            (select count(*) from agente.mensagens m where m.conversa_id = c.id) as mensagens
       from agente.conversas c
       join agente.contatos ct on ct.id = c.contato_id
      where ($1 = '' or ct.telefone ilike '%' || $1 || '%' or coalesce(ct.nome,'') ilike '%' || $1 || '%')
      order by c.ultima_msg_em desc
      limit $2`,
    [termo, limite],
  );

  return rows.map((r) => ({
    id: r.id,
    nome: r.nome,
    telefone: r.telefone,
    ultimaMsgEm: r.ultima_msg_em,
    status: r.status,
    desfecho: r.desfecho,
    resumo: r.resumo,
    // A IA está no comando quando a conversa segue ativa e ninguém do balcão
    // assumiu o contato nas últimas horas.
    iaAtiva:
      r.status === "ativa" &&
      (r.silenciado_ate === null || new Date(r.silenciado_ate) <= new Date()),
    mensagens: Number(r.mensagens),
  }));
}

export async function acaoLerConversa(pool: Pool, id: string) {
  const { rows: cab } = await pool.query(
    `select c.id, c.status, c.intencao, c.desfecho, c.resumo, c.iniciada_em,
            ct.nome, ct.telefone, ct.silenciado_ate,
            m.marca, m.modelo, m.cilindrada
       from agente.conversas c
       join agente.contatos ct on ct.id = c.contato_id
       left join agente.motos m on m.id = ct.moto_id
      where c.id = $1`,
    [id],
  );
  if (!cab[0]) return { erro: "conversa não encontrada" };

  const { rows: msgs } = await pool.query(
    `select papel, conteudo, tipo_midia, criado_em, modelo
       from agente.mensagens where conversa_id = $1
      order by criado_em asc, id asc`,
    [id],
  );

  const c = cab[0];
  return {
    id: c.id,
    nome: c.nome,
    telefone: c.telefone,
    status: c.status,
    intencao: c.intencao,
    desfecho: c.desfecho,
    resumo: c.resumo,
    iniciadaEm: c.iniciada_em,
    moto: c.modelo ? `${c.marca} ${c.modelo} ${c.cilindrada ?? ""}`.trim() : null,
    iaAtiva:
      c.status === "ativa" &&
      (c.silenciado_ate === null || new Date(c.silenciado_ate) <= new Date()),
    mensagens: msgs.map((m) => ({
      papel: m.papel,
      conteudo: m.conteudo ?? "",
      tipoMidia: m.tipo_midia,
      criadoEm: m.criado_em,
      modelo: m.modelo,
    })),
  };
}

/**
 * Liga ou desliga a IA numa conversa específica.
 *
 * Desligar marca a conversa como `aguardando_humano` e silencia o contato por
 * 6 horas — o mesmo efeito de o balcão ter respondido pelo WhatsApp. Religar
 * limpa o silêncio e devolve a conversa ao agente.
 */
export async function acaoAlternarIa(
  pool: Pool,
  id: string,
  iaAtiva: boolean,
): Promise<{ ok: true } | { erro: string }> {
  const { rows } = await pool.query(
    "select contato_id from agente.conversas where id = $1",
    [id],
  );
  if (!rows[0]) return { erro: "conversa não encontrada" };

  if (iaAtiva) {
    await pool.query("update agente.conversas set status = 'ativa' where id = $1", [id]);
    await pool.query(
      "update agente.contatos set silenciado_ate = null where id = $1",
      [rows[0].contato_id],
    );
  } else {
    await pool.query(
      "update agente.conversas set status = 'aguardando_humano' where id = $1",
      [id],
    );
    await pool.query(
      "update agente.contatos set silenciado_ate = now() + interval '6 hours' where id = $1",
      [rows[0].contato_id],
    );
  }
  return { ok: true };
}

export async function acaoMetricas(pool: Pool) {
  const um = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0]!.n);
  return {
    produtos: await um("select count(*)::text as n from agente.produtos where ativo"),
    comFitment: await um("select count(distinct produto_id)::text as n from agente.produto_moto"),
    motos: await um("select count(*)::text as n from agente.motos"),
    demandas: await um(
      "select count(*)::text as n from agente.demanda_nao_atendida where criado_em > now() - interval '30 days'",
    ),
  };
}

/**
 * Roda um turno com o prompt que está na tela, não com o que está salvo:
 * é o que permite testar uma mudança antes de ela valer para o cliente.
 */
export async function acaoTestar(
  pool: Pool,
  anthropic: Anthropic,
  corpo: { mensagem?: string; prompt?: string; historico?: Fala[] },
) {
  const mensagem = String(corpo.mensagem ?? "").trim();
  if (mensagem === "") return { erro: "mensagem vazia" };

  const cfg = await lerConfig(pool, false);
  // Sem texto na tela, testa o que está valendo de verdade para o cliente
  // (o customizado, se o dono salvou um) — não o padrão do código.
  const prompt = corpo.prompt && corpo.prompt.trim() !== "" ? corpo.prompt : promptEfetivo(cfg);

  const historico: Fala[] = Array.isArray(corpo.historico) ? corpo.historico : [];
  if (historico.at(-1)?.conteudo !== mensagem) {
    historico.push({ papel: "cliente", conteudo: mensagem });
  }

  const ferramentas: string[] = [];
  const turno = await responder(
    {
      anthropic,
      prompt,
      // O mesmo contexto que a produção manda, para o teste não responder
      // com uma data diferente da que o cliente veria.
      contexto: montarContexto({ agora: new Date(), nome: null, moto: null }),
      // conversaId null: teste do painel não entra no funil de métricas.
      executar: (nome, entrada) =>
        executarFerramenta(pool, { conversaId: null, contatoId: null }, nome, entrada),
      aoUsarFerramenta: (nome, entrada) => ferramentas.push(`${nome}(${JSON.stringify(entrada)})`),
    },
    historico,
  );
  return { ...turno, ferramentas };
}
