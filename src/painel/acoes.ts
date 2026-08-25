import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { criarPool } from "../db/pool.js";
import {
  lerConfig,
  gravarConfig,
  promptPadrao,
  promptEfetivo,
  modeloConhecido,
  MODELOS_DISPONIVEIS,
  type ConfigLoja,
} from "../config/loja.js";
import { publicarVersao, registrar } from "./versoes.js";
import { montarContexto } from "../agente/prompt.js";
import { responder, type Fala } from "../agente/laco.js";
import { executarFerramenta } from "../ferramentas/executar.js";
import { enviar } from "../saida/evolution.js";
import { gravarMensagem } from "../conversa/historico.js";

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
  return {
    ...cfg,
    promptPadrao: promptPadrao(cfg),
    modelos: MODELOS_DISPONIVEIS,
    // Só o estado, nunca a chave. A tela precisa saber se o áudio do cliente
    // vira texto ou vai direto ao balcão; ninguém precisa ver o segredo.
    transcricao: {
      ativa: Boolean(process.env.TRANSCRICAO_API_KEY?.trim()),
      modelo: process.env.TRANSCRICAO_MODELO?.trim() || "whisper-1",
    },
  };
}

/** Valida antes de gravar: o painel não pode salvar algo que derrube o agente. */
export async function acaoGravarConfig(
  pool: Pool,
  c: Partial<ConfigLoja> & { nota?: string },
): Promise<{ ok: true; versao?: number } | { erro: string }> {
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
  // Lista fechada: o valor vai direto para o campo `model` da API, e um nome
  // errado só apareceria como erro na cara do cliente.
  if (c.modeloConversa !== undefined && !modeloConhecido(c.modeloConversa)) {
    return { erro: `modelo desconhecido: ${c.modeloConversa}` };
  }

  const antes = await lerConfig(pool, false);
  const { nota, ...campos } = c;
  await gravarConfig(pool, campos);

  if (campos.botAtivo !== undefined && campos.botAtivo !== antes.botAtivo) {
    await registrar(pool, campos.botAtivo ? "ligar_bot" : "desligar_bot");
  }

  // Só mexer no que define o comportamento cria versão. Trocar o endereço da
  // loja não é uma versão nova do agente, e numerar isso encheria o histórico
  // de linhas que ninguém vai querer restaurar.
  const mudouComportamento =
    (campos.modeloConversa !== undefined && campos.modeloConversa !== antes.modeloConversa) ||
    (campos.promptCustomizado !== undefined && campos.promptCustomizado !== antes.promptCustomizado);

  if (!mudouComportamento) return { ok: true };

  const depois = await lerConfig(pool, false);
  const versao = await publicarVersao(pool, depois, nota ?? null);
  return { ok: true, versao: versao.numero };
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
  await registrar(pool, iaAtiva ? "religar_ia" : "assumir_conversa", { conversaId: id });
  return { ok: true };
}

/** Formato de uuid. Filtra antes do banco: um id torto abortaria o lote todo. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Teto por chamada. Acima disso é engano de clique, não intenção. */
const MAX_LOTE = 200;

/**
 * Liga ou desliga a IA em várias conversas de uma vez.
 *
 * Na segunda-feira de manhã o balcão chega com a fila da madrugada inteira
 * marcada como "aguardando humano" — devolver uma por uma é o tipo de
 * trabalho que faz o painel deixar de ser usado. E quando o atendimento sai
 * do rumo, o dono precisa calar o agente em tudo que está aberto agora, não
 * daqui a quarenta cliques.
 *
 * Faz o mesmo que `acaoAlternarIa`, em duas instruções de conjunto em vez de
 * duas por conversa: com cem conversas selecionadas, a diferença entre isto
 * e um laço é duzentas idas ao Supabase.
 */
export async function acaoAlternarIaEmLote(
  pool: Pool,
  ids: unknown,
  iaAtiva: boolean,
): Promise<{ ok: true; alteradas: number } | { erro: string }> {
  const limpos = [
    ...new Set(
      (Array.isArray(ids) ? ids : []).filter((i): i is string => typeof i === "string" && UUID.test(i)),
    ),
  ];

  if (limpos.length === 0) return { erro: "nenhuma conversa selecionada" };
  if (limpos.length > MAX_LOTE) {
    return { erro: `no máximo ${MAX_LOTE} conversas por vez — foram ${limpos.length}` };
  }

  // O silêncio do contato e o status da conversa andam juntos: quem só
  // mudasse o status veria a conversa "ativa" e o agente continuaria calado
  // pelas seis horas do silenciamento.
  const contatos = `select contato_id from agente.conversas where id = any($1::uuid[])`;

  if (iaAtiva) {
    const r = await pool.query(
      "update agente.conversas set status = 'ativa' where id = any($1::uuid[])",
      [limpos],
    );
    await pool.query(
      `update agente.contatos set silenciado_ate = null where id in (${contatos})`,
      [limpos],
    );
    await registrar(pool, "religar_ia_lote", { quantas: r.rowCount ?? 0 });
    return { ok: true, alteradas: r.rowCount ?? 0 };
  }

  const r = await pool.query(
    "update agente.conversas set status = 'aguardando_humano' where id = any($1::uuid[])",
    [limpos],
  );
  await pool.query(
    `update agente.contatos set silenciado_ate = now() + interval '6 hours' where id in (${contatos})`,
    [limpos],
  );
  await registrar(pool, "assumir_conversa_lote", { quantas: r.rowCount ?? 0 });
  return { ok: true, alteradas: r.rowCount ?? 0 };
}

/**
 * Responde ao cliente pelo painel, como balcão.
 *
 * Antes disto, assumir uma conversa significava largar o painel e procurar o
 * contato no WhatsApp do celular — e o que foi respondido lá não voltava para
 * o histórico. Aqui a resposta sai pelo mesmo número e fica gravada como
 * `humano`, então a próxima pessoa que abrir a conversa vê o que já foi dito.
 *
 * Mandar uma mensagem daqui cala o agente na conversa: dois atendentes
 * respondendo o mesmo cliente é pior do que nenhum.
 */
export async function acaoResponderManual(
  pool: Pool,
  id: string,
  texto: string,
): Promise<{ ok: true } | { erro: string }> {
  const conteudo = String(texto ?? "").trim();
  if (conteudo === "") return { erro: "mensagem vazia" };
  if (conteudo.length > 4000) return { erro: "mensagem longa demais" };

  const url = process.env.EVOLUTION_URL?.trim();
  const apiKey = process.env.EVOLUTION_API_KEY?.trim();
  if (!url || !apiKey) {
    return { erro: "EVOLUTION_URL e EVOLUTION_API_KEY não estão configuradas neste ambiente" };
  }

  const { rows } = await pool.query<{ contato_id: string; telefone: string }>(
    `select c.contato_id, ct.telefone
       from agente.conversas c
       join agente.contatos ct on ct.id = c.contato_id
      where c.id = $1`,
    [id],
  );
  const alvo = rows[0];
  if (!alvo) return { erro: "conversa não encontrada" };

  try {
    await enviar(
      pool,
      { url, apiKey, instancia: process.env.EVOLUTION_INSTANCIA?.trim() || "minas" },
      alvo.telefone,
      conteudo,
    );
  } catch (erro) {
    return { erro: `não saiu: ${(erro as Error).message}` };
  }

  await gravarMensagem(pool, { conversaId: id, papel: "humano", conteudo });
  // Quem respondeu assumiu. Sem isto o agente responderia por cima na
  // mensagem seguinte do cliente.
  await pool.query(
    "update agente.conversas set status = 'aguardando_humano' where id = $1 and status = 'ativa'",
    [id],
  );
  await pool.query(
    "update agente.contatos set silenciado_ate = now() + interval '6 hours' where id = $1",
    [alvo.contato_id],
  );
  await registrar(pool, "responder_manual", { conversaId: id });
  return { ok: true };
}

/**
 * Os números da tela inicial.
 *
 * Numa consulta só, e não uma por número: cada round-trip para o Supabase
 * custa uns 80 ms de latência da rede residencial, e catorze deles em série
 * deixavam a tela inicial visivelmente lenta.
 *
 * "Hoje" é o dia em Belém, não em UTC: o dono abre isto às 8h da manhã e o
 * número precisa bater com o que ele viu no balcão ontem.
 */
export async function acaoMetricas(pool: Pool) {
  const { rows } = await pool.query(`
    select
      (select count(*) from agente.produtos where ativo)                             as produtos,
      (select count(*) from agente.produtos where ativo and preco_centavos is not null) as com_preco,
      (select count(distinct produto_id) from agente.produto_moto)                   as com_fitment,
      (select count(*) from agente.motos)                                            as motos,
      (select count(*) from agente.servicos where ativo)                             as servicos,
      (select count(*) from agente.demanda_nao_atendida
        where criado_em > now() - interval '30 days')                                as demandas,
      (select count(*) from agente.conversas
        where iniciada_em >= date_trunc('day', now() at time zone 'America/Belem')
                             at time zone 'America/Belem')                           as conversas_hoje,
      (select count(*) from agente.mensagens
        where criado_em >= date_trunc('day', now() at time zone 'America/Belem')
                            at time zone 'America/Belem')                            as mensagens_hoje,
      (select count(*) from agente.conversas where status = 'aguardando_humano')     as aguardando,
      (select count(*) from agente.conversas where status = 'ativa')                 as ativas,
      (select count(*) from agente.conversas
        where desfecho = 'qualificou' and iniciada_em > now() - interval '7 days')   as qualificadas_7d,
      (select count(*) from agente.conversas
        where iniciada_em > now() - interval '7 days')                               as conversas_7d,
      (select coalesce(sum(tokens_in), 0) from agente.mensagens
        where criado_em > now() - interval '24 hours')                               as tokens_in_24h,
      (select coalesce(sum(tokens_out), 0) from agente.mensagens
        where criado_em > now() - interval '24 hours')                               as tokens_out_24h,
      (select count(*) from agente.saidas_pendentes)                                 as saidas_presas
  `);

  // Volume por hora das últimas 24. A série existe para a tela mostrar em que
  // horário o cliente escreve — é o que diz se vale ligar o agente à noite.
  const { rows: porHora } = await pool.query<{ h: string; n: string }>(`
    select to_char(date_trunc('hour', criado_em at time zone 'America/Belem'), 'HH24') as h,
           count(*)::text as n
      from agente.mensagens
     where criado_em > now() - interval '24 hours'
     group by 1
  `);
  const mapaHoras = new Map(porHora.map((p) => [Number(p.h), Number(p.n)]));
  const horaAgora = Number(
    new Date().toLocaleString("en-US", { timeZone: "America/Belem", hour: "2-digit", hour12: false }),
  );
  const serie24h = Array.from({ length: 24 }, (_, i) => {
    const hora = (horaAgora - 23 + i + 48) % 24;
    return { hora, mensagens: mapaHoras.get(hora) ?? 0 };
  });

  const r = rows[0]!;
  const n = (v: unknown) => Number(v ?? 0);

  return {
    serie24h,
    produtos: n(r.produtos),
    comPreco: n(r.com_preco),
    comFitment: n(r.com_fitment),
    motos: n(r.motos),
    servicos: n(r.servicos),
    demandas: n(r.demandas),
    conversasHoje: n(r.conversas_hoje),
    mensagensHoje: n(r.mensagens_hoje),
    aguardando: n(r.aguardando),
    ativas: n(r.ativas),
    qualificadas7d: n(r.qualificadas_7d),
    conversas7d: n(r.conversas_7d),
    tokensIn24h: n(r.tokens_in_24h),
    tokensOut24h: n(r.tokens_out_24h),
    saidasPresas: n(r.saidas_presas),
  };
}

/**
 * O que o cliente pediu e a loja não tinha, agrupado.
 *
 * Vira lista de compra. Uma linha por pedido não serve de nada — o que
 * interessa é a peça que dez pessoas pediram no mês, e isso só aparece
 * quando se agrupa pelo texto normalizado.
 */
export async function acaoDemandas(pool: Pool, dias = 30) {
  const { rows } = await pool.query(
    `select coalesce(peca_norm, texto_bruto) as peca,
            count(*)                          as pedidos,
            max(criado_em)                    as ultimo,
            array_agg(distinct motivo)        as motivos
       from agente.demanda_nao_atendida
      where criado_em > now() - ($1 || ' days')::interval
      group by 1
      order by pedidos desc, ultimo desc
      limit 40`,
    [String(dias)],
  );

  return rows.map((r) => ({
    peca: r.peca,
    pedidos: Number(r.pedidos),
    ultimo: r.ultimo,
    motivos: r.motivos as string[],
  }));
}

/**
 * As mensagens que não saíram.
 *
 * `saidas_pendentes` só enche quando o Evolution esteve fora do ar. Uma linha
 * aqui é cliente esperando resposta que nunca chegou — por isso o número vai
 * para a tela inicial e a lista fica a um clique.
 */
export async function acaoSaidasPresas(pool: Pool) {
  const { rows } = await pool.query(
    `select id, telefone, conteudo, tentativas, erro, criado_em
       from agente.saidas_pendentes order by criado_em asc limit 50`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    telefone: r.telefone,
    conteudo: r.conteudo,
    tentativas: Number(r.tentativas),
    erro: r.erro,
    criadoEm: r.criado_em,
  }));
}

/**
 * Roda um turno com o prompt que está na tela, não com o que está salvo:
 * é o que permite testar uma mudança antes de ela valer para o cliente.
 */
export async function acaoTestar(
  pool: Pool,
  anthropic: Anthropic,
  corpo: { mensagem?: string; prompt?: string; historico?: Fala[]; modelo?: string },
) {
  const mensagem = String(corpo.mensagem ?? "").trim();
  if (mensagem === "") return { erro: "mensagem vazia" };
  if (corpo.modelo !== undefined && !modeloConhecido(corpo.modelo)) {
    return { erro: `modelo desconhecido: ${corpo.modelo}` };
  }

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
      // Testar com o modelo que a tela está oferecendo, não com o salvo:
      // é o que permite comparar duas versões antes de publicar uma delas.
      modelo: corpo.modelo ?? cfg.modeloConversa,
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
