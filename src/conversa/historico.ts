import type { Pool } from "pg";

export type Papel = "cliente" | "agente" | "humano" | "sistema";
export type Status = "ativa" | "aguardando_humano" | "encerrada";

export interface Conversa {
  id: string;
  status: Status;
  iniciadaEm: Date;
}

export interface NovaMensagem {
  conversaId: string;
  papel: Papel;
  conteudo: string;
  msgExtId?: string | null;
  tipoMidia?: "texto" | "imagem" | "audio";
  midiaUrl?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  modelo?: string | null;
}

export interface Mensagem {
  papel: Papel;
  conteudo: string;
  tipoMidia: string;
  criadoEm: Date;
}

/**
 * Devolve a conversa aberta do contato, criando uma se não houver.
 *
 * "Aberta" é status diferente de 'encerrada' — inclui 'aguardando_humano',
 * porque conversa que o balcão assumiu continua sendo a mesma conversa.
 */
export async function conversaAtiva(pool: Pool, contatoId: string): Promise<Conversa> {
  const { rows } = await pool.query(
    `select id, status, iniciada_em from agente.conversas
      where contato_id = $1 and status <> 'encerrada'
      order by iniciada_em desc limit 1`,
    [contatoId],
  );

  if (rows[0]) {
    return { id: rows[0].id, status: rows[0].status, iniciadaEm: rows[0].iniciada_em };
  }

  const nova = await pool.query(
    `insert into agente.conversas (contato_id) values ($1)
     returning id, status, iniciada_em`,
    [contatoId],
  );
  const r = nova.rows[0]!;
  return { id: r.id, status: r.status, iniciadaEm: r.iniciada_em };
}

/**
 * Grava a mensagem e diz se ela é nova.
 *
 * `false` significa que este `msg_ext_id` já estava no banco: o Evolution
 * reenviou o webhook porque não recebeu 200 a tempo. Quem chama deve parar
 * aí — responder duas vezes à mesma mensagem é o erro que o cliente enxerga.
 *
 * Mensagem do agente vai sem `msg_ext_id` (null), e null nunca conflita em
 * índice único do Postgres — então o agente pode falar quantas vezes precisar.
 */
export async function gravarMensagem(pool: Pool, m: NovaMensagem): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into agente.mensagens
       (conversa_id, papel, conteudo, tipo_midia, midia_url, msg_ext_id, tokens_in, tokens_out, modelo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (msg_ext_id) do nothing`,
    [
      m.conversaId,
      m.papel,
      m.conteudo,
      m.tipoMidia ?? "texto",
      m.midiaUrl ?? null,
      m.msgExtId ?? null,
      m.tokensIn ?? null,
      m.tokensOut ?? null,
      m.modelo ?? null,
    ],
  );

  if ((rowCount ?? 0) > 0) {
    await pool.query("update agente.conversas set ultima_msg_em = now() where id = $1", [
      m.conversaId,
    ]);
    return true;
  }
  return false;
}

/**
 * Janela de contexto entregue ao modelo, em ordem cronológica.
 *
 * O desempate é pelo `id` nos dois sentidos: a subconsulta pega as N mais
 * recentes com `criado_em desc, id desc` e a de fora reordena com o espelho
 * exato disso. Desempatar de outro jeito lá fora inverteria pergunta e
 * resposta quando as duas caem no mesmo instante.
 */
export async function ultimasMensagens(
  pool: Pool,
  conversaId: string,
  limite = 12,
): Promise<Mensagem[]> {
  const { rows } = await pool.query(
    `select papel, conteudo, tipo_midia, criado_em from (
       select id, papel, conteudo, tipo_midia, criado_em from agente.mensagens
        where conversa_id = $1 order by criado_em desc, id desc limit $2
     ) t order by criado_em asc, id asc`,
    [conversaId, limite],
  );

  return rows.map((r) => ({
    papel: r.papel,
    conteudo: r.conteudo ?? "",
    tipoMidia: r.tipo_midia,
    criadoEm: r.criado_em,
  }));
}

/**
 * Muda o status da conversa e, opcionalmente, os campos de fechamento.
 *
 * `coalesce` em cada campo para que passar só `desfecho` não apague o resumo
 * que a ferramenta de handoff já tinha escrito.
 */
export async function marcarStatus(
  pool: Pool,
  conversaId: string,
  status: Status,
  campos: { intencao?: string; desfecho?: string; resumo?: string } = {},
): Promise<void> {
  await pool.query(
    `update agente.conversas
        set status = $2,
            intencao = coalesce($3, intencao),
            desfecho = coalesce($4, desfecho),
            resumo   = coalesce($5, resumo)
      where id = $1`,
    [conversaId, status, campos.intencao ?? null, campos.desfecho ?? null, campos.resumo ?? null],
  );
}
