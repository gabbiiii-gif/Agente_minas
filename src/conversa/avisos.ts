import type { Pool } from "pg";

/**
 * Registro do que saiu para o telefone do dono.
 *
 * Mora aqui, e não em `painel/dono.ts`, pelo mesmo motivo que `sinonimos.ts`
 * não mora em `semear.ts`: quem grava isto também é o gateway, e o gateway
 * roda como Edge Function. O módulo do painel importa `pg`, `node:fs` e o
 * relatório inteiro — arrastar tudo isso para dentro do grafo do Deno
 * quebraria o deploy. Aqui só existe o INSERT.
 */

export type TipoAviso = "relatorio" | "alerta" | "manual" | "teste";

/**
 * Anota a tentativa, tenha ela dado certo ou não.
 *
 * O que falhou é justamente o que interessa ver depois. Nunca lança: perder a
 * linha do histórico é ruim, derrubar o alerta por causa dela é pior — e
 * alerta que quebra é pior que alerta que falta.
 */
export async function anotarAviso(
  pool: Pool,
  tipo: TipoAviso,
  texto: string,
  telefone: string | null,
  erro?: string,
): Promise<void> {
  try {
    await pool.query(
      `insert into agente.avisos_dono (tipo, texto, telefone, enviado, erro)
       values ($1, $2, $3, $4, $5)`,
      [tipo, texto, telefone, erro === undefined, erro ?? null],
    );
  } catch {
    // Sem histórico a vida segue.
  }
}
