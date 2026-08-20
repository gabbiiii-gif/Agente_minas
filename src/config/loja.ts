import type { Pool } from "pg";
import { montarPrompt } from "../agente/prompt.js";

/**
 * Configuração que o dono muda sem mexer em código nem fazer deploy.
 *
 * Mora em `agente.config` (chave/valor jsonb) e é lida a cada turno de
 * conversa. O cache de um minuto existe para não consultar o banco a cada
 * mensagem, mas é curto de propósito: quando o dono desliga o bot no painel,
 * o efeito precisa valer em segundos, não no próximo deploy.
 */
export interface ConfigLoja {
  botAtivo: boolean;
  horario: string;
  endereco: string;
  tetoContatosNovosHora: number;
  maxMensagensConversa: number;
  /** null = usa o prompt padrão do código; texto = o dono editou no painel. */
  promptCustomizado: string | null;
}

const PADRAO: ConfigLoja = {
  botAtivo: true,
  horario: "Seg a Sex 8h-18h · Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
  tetoContatosNovosHora: 12,
  maxMensagensConversa: 30,
  promptCustomizado: null,
};

const VALIDADE_CACHE_MS = 60_000;

let cache: { valor: ConfigLoja; em: number } | null = null;

/** Chaves como estão gravadas em `agente.config`. */
const CHAVES: Record<keyof ConfigLoja, string> = {
  botAtivo: "bot_ativo",
  horario: "horario_funcionamento",
  endereco: "endereco",
  tetoContatosNovosHora: "teto_contatos_novos_hora",
  maxMensagensConversa: "max_mensagens_conversa",
  promptCustomizado: "prompt_sistema",
};

export async function lerConfig(pool: Pool, usarCache = true): Promise<ConfigLoja> {
  if (usarCache && cache !== null && Date.now() - cache.em < VALIDADE_CACHE_MS) {
    return cache.valor;
  }

  const { rows } = await pool.query<{ chave: string; valor: unknown }>(
    "select chave, valor from agente.config",
  );
  const mapa = new Map(rows.map((r) => [r.chave, r.valor]));

  const pegar = <T>(chave: string, padrao: T): T => {
    const v = mapa.get(chave);
    return v === undefined || v === null ? padrao : (v as T);
  };

  const valor: ConfigLoja = {
    botAtivo: pegar(CHAVES.botAtivo, PADRAO.botAtivo),
    horario: pegar(CHAVES.horario, PADRAO.horario),
    endereco: pegar(CHAVES.endereco, PADRAO.endereco),
    tetoContatosNovosHora: pegar(CHAVES.tetoContatosNovosHora, PADRAO.tetoContatosNovosHora),
    maxMensagensConversa: pegar(CHAVES.maxMensagensConversa, PADRAO.maxMensagensConversa),
    promptCustomizado: pegar<string | null>(CHAVES.promptCustomizado, null),
  };

  cache = { valor, em: Date.now() };
  return valor;
}

/** Grava só as chaves informadas e derruba o cache, para o efeito ser imediato. */
export async function gravarConfig(
  pool: Pool,
  parcial: Partial<ConfigLoja>,
): Promise<void> {
  for (const [campo, valor] of Object.entries(parcial)) {
    const chave = CHAVES[campo as keyof ConfigLoja];
    if (chave === undefined) continue;
    await pool.query(
      `insert into agente.config (chave, valor) values ($1, $2::jsonb)
       on conflict (chave) do update set valor = excluded.valor`,
      [chave, JSON.stringify(valor ?? null)],
    );
  }
  cache = null;
}

/**
 * A parte fixa do prompt que vai para o modelo.
 *
 * Se o dono editou no painel, usa o texto dele como está — inclusive os erros,
 * porque é ele quem manda no atendimento. Senão monta o padrão do código com
 * horário e endereço atuais.
 *
 * Não recebe data nem dados do cliente de propósito: essa parte é
 * `montarContexto`, que entra num segundo bloco do system justamente para não
 * invalidar o cache a cada mensagem — ver `laco.ts`.
 */
export function promptEfetivo(cfg: ConfigLoja): string {
  if (cfg.promptCustomizado !== null && cfg.promptCustomizado.trim() !== "") {
    return cfg.promptCustomizado;
  }
  return montarPrompt({ horario: cfg.horario, endereco: cfg.endereco });
}

/** O padrão do código, para o painel oferecer "restaurar". */
export function promptPadrao(cfg: ConfigLoja): string {
  return montarPrompt({ horario: cfg.horario, endereco: cfg.endereco });
}
