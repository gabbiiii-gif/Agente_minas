import type { Pool } from "pg";

export interface Contato {
  id: string;
  telefone: string;
  nome: string | null;
  motoId: string | null;
  silenciadoAte: Date | null;
  /** true quando esta mensagem criou o contato — alimenta o teto anti-banimento. */
  novo: boolean;
}

/**
 * Quanto tempo o bot fica calado depois que o balcão responde na conversa.
 * Renovado a cada mensagem humana: enquanto o atendente estiver ativo, o
 * silêncio se estende sozinho.
 */
const HORAS_DE_SILENCIO = 6;

/**
 * Acha o contato pelo telefone, criando se for a primeira mensagem dele.
 *
 * O nome só é sobrescrito quando vem preenchido — o pushName do WhatsApp às
 * vezes chega vazio, e não faz sentido apagar um nome que já se sabia.
 *
 * O insert com `on conflict` faz as duas coisas numa consulta só: buscar
 * antes para decidir entre insert e update abriria janela para duas
 * mensagens simultâneas do mesmo cliente criarem dois contatos.
 */
export async function resolverContato(
  pool: Pool,
  telefone: string,
  nome: string,
): Promise<Contato> {
  const { rows } = await pool.query(
    `insert into agente.contatos (telefone, nome)
     values ($1, nullif($2, ''))
     on conflict (telefone) do update
       set nome = coalesce(nullif($2, ''), agente.contatos.nome)
     returning id, telefone, nome, moto_id, silenciado_ate, (xmax = 0) as inserido`,
    [telefone, nome],
  );

  const r = rows[0]!;
  return {
    id: r.id,
    telefone: r.telefone,
    nome: r.nome,
    motoId: r.moto_id,
    silenciadoAte: r.silenciado_ate,
    // `xmax = 0` distingue linha inserida de linha atualizada no mesmo
    // upsert. Sem isso não dá para saber que este é o primeiro contato da
    // pessoa sem uma segunda consulta.
    novo: r.inserido === true,
  };
}

/** Puro de propósito: o gateway decide calar sem ir ao banco de novo. */
export function estaSilenciado(contato: Contato, agora: Date): boolean {
  return contato.silenciadoAte !== null && contato.silenciadoAte > agora;
}

/**
 * Cala o bot naquele contato por algumas horas.
 *
 * Chamado quando chega mensagem `fromMe` — o balcão respondeu pelo celular e
 * a IA não pode falar por cima de quem já está atendendo.
 */
export async function silenciarPorHumano(
  pool: Pool,
  contatoId: string,
  agora: Date = new Date(),
): Promise<void> {
  const ate = new Date(agora.getTime() + HORAS_DE_SILENCIO * 3600_000);
  await pool.query("update agente.contatos set silenciado_ate = $2 where id = $1", [
    contatoId,
    ate,
  ]);
}

/**
 * Quantos contatos novos apareceram na última hora.
 *
 * Serve ao teto anti-banimento: número não oficial que de repente fala com
 * muita gente nova é padrão que o WhatsApp pune.
 */
export async function contatosNovosNaUltimaHora(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from agente.contatos where criado_em > now() - interval '1 hour'",
  );
  return Number(rows[0]!.n);
}
