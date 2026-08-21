import type { Pool } from "pg";

/**
 * Debounce que não depende de memória do processo.
 *
 * O debounce em memória (`debounce.ts`) só funciona num processo sempre
 * ligado: o `setTimeout` precisa de alguém vivo para dispará-lo. Em
 * serverless cada mensagem do cliente é uma invocação diferente, possivelmente
 * em outra máquina, e não há memória compartilhada — o turno se perderia em
 * silêncio.
 *
 * Aqui o ponto de combinação entre as invocações é o banco. Cada invocação
 * anota o `ultima_msg_em` que viu, dorme a janela e relê. Se o carimbo mudou,
 * é porque chegou mensagem nova e uma invocação mais recente assumiu — esta
 * sai sem fazer nada. Se não mudou, o cliente parou de digitar e esta
 * invocação é a que responde.
 *
 * O efeito é o mesmo do outro: mensagens picadas viram um turno só, e quem
 * responde é sempre a última. A diferença é que aqui a invocação fica parada
 * durante a janela, então ela conta no tempo de execução da função.
 */
export async function esperarVez(
  pool: Pool,
  conversaId: string,
  esperaMs: number,
  dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const antes = await carimbo(pool, conversaId);
  if (antes === null) return false;

  await dormir(esperaMs);

  const depois = await carimbo(pool, conversaId);
  return depois !== null && depois === antes;
}

/**
 * Momento da última mensagem, em milissegundos.
 *
 * Comparado como número e não como Date porque duas leituras do mesmo
 * instante são objetos diferentes — `===` entre Dates nunca daria true.
 */
async function carimbo(pool: Pool, conversaId: string): Promise<number | null> {
  const { rows } = await pool.query<{ ultima_msg_em: Date }>(
    "select ultima_msg_em from agente.conversas where id = $1",
    [conversaId],
  );
  const v = rows[0]?.ultima_msg_em;
  return v ? new Date(v).getTime() : null;
}
