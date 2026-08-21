// Gateway do WhatsApp como Supabase Edge Function.
//
// Mesmo miolo do processo Node: `atender`, `responderTurno`, ferramentas,
// prompt e busca vêm todos de `src/`, sem cópia. Só duas coisas mudam aqui, e
// as duas por causa de serverless:
//
//   1. O banco. `pg` é de Node; aqui entra um cliente Deno atrás de um
//      adaptador com o mesmo `query(sql, params)`. Funciona porque nenhum
//      módulo do miolo importa `pg` em runtime — todos importam só o tipo.
//   2. O debounce. `setTimeout` em memória não sobrevive entre invocações;
//      quem espera a janela aqui é `esperarVez`, pelo banco.
//
// Deploy: supabase functions deploy whatsapp-webhook --no-verify-jwt
// (--no-verify-jwt porque quem chama é o Evolution, que não tem JWT do
// Supabase; a autenticação é o segredo abaixo.)
import { Pool as PoolDeno } from "jsr:@db/postgres@0.19";
import Anthropic from "npm:@anthropic-ai/sdk@0.120.0";
import { criarAtendimento } from "../../../src/gateway/atender.ts";
import { esperarVez } from "../../../src/gateway/janela.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

const SEGREDO = env("WEBHOOK_SEGREDO");
const ESPERA_MS = Number(env("DEBOUNCE_MS") || 8000);

/**
 * Pool do Deno com a mesma cara do `pg`.
 *
 * O miolo só chama `query(sql, params)` e lê `rows`. O adaptador existe para
 * não ter que tocar em nenhum dos arquivos compartilhados.
 */
// `SUPABASE_DB_URL` é injetada pelo próprio runtime e aponta para o banco do
// projeto — um segredo a menos para configurar e para errar. `DATABASE_URL`
// existe para rodar a função localmente contra o Postgres de teste.
const poolDeno = new PoolDeno(env("DATABASE_URL") || env("SUPABASE_DB_URL"), 3, true);

const pool = {
  async query(texto: string, params: unknown[] = []) {
    const conexao = await poolDeno.connect();
    try {
      const r = await conexao.queryObject({ text: texto, args: params });
      return {
        rows: r.rows as any[],
        // `rowCount` precisa ser LINHAS AFETADAS, não linhas devolvidas.
        // `gravarMensagem` decide por ele se a mensagem é nova, e um INSERT
        // sem RETURNING devolve zero linhas — usar `rows.length` faria toda
        // mensagem parecer webhook repetido, e o agente nunca responderia.
        rowCount: r.rowCount ?? r.rows.length,
      };
    } finally {
      conexao.release();
    }
  },
} as any;

const atendimento = criarAtendimento({
  pool,
  anthropic: new Anthropic({ apiKey: env("ANTHROPIC_API_KEY"), maxRetries: 2 }),
  evolution: {
    url: env("EVOLUTION_URL"),
    apiKey: env("EVOLUTION_API_KEY"),
    instancia: env("EVOLUTION_INSTANCIA") || "minas",
  },
  telefoneDono: env("TELEFONE_DONO") || null,
  // Ninguém agenda por aqui: quem espera a janela é `esperarVez`, abaixo.
  debounce: { registrar: () => {}, pendentes: () => 0, encerrar: () => {} },
});

/**
 * O segredo pode vir no header ou na query.
 *
 * Header é o certo — token em URL vaza para log de servidor e histórico de
 * navegador com facilidade. Mas nem toda tela do Evolution deixa editar
 * headers, e nesse caso a query é a única saída.
 */
function autorizado(req: Request): boolean {
  if (SEGREDO === "") return false;
  if (req.headers.get("x-webhook-segredo") === SEGREDO) return true;
  return new URL(req.url).searchParams.get("token") === SEGREDO;
}

Deno.serve(async (req: Request) => {
  if (new URL(req.url).pathname.endsWith("/saude")) {
    return Response.json({ ok: true });
  }

  if (!autorizado(req)) {
    return Response.json({ erro: "segredo inválido" }, { status: 401 });
  }

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return Response.json({ erro: "corpo não é json" }, { status: 400 });
  }

  // Aqui NÃO dá para responder 200 antes de processar, como faz o servidor
  // Node: em serverless a invocação morre junto com a resposta e o turno
  // nunca rodaria. Então o trabalho acontece antes, e o Evolution espera.
  // A proteção contra o reenvio dele continua sendo a idempotência por
  // msg_ext_id, que já barra a mensagem repetida em `gravarMensagem`.
  try {
    const conversaId = await atendimento.atender(corpo);

    if (conversaId !== null && (await esperarVez(pool, conversaId, ESPERA_MS))) {
      await atendimento.responderTurno(conversaId);
    }
  } catch (erro) {
    console.error("falha ao atender mensagem:", erro);
  }

  return Response.json({ ok: true });
});
