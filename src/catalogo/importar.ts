import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { descompactar, parsearPlanilha, validarCabecalho } from "./planilha.js";
import { normalizar } from "./normalizar.js";
import { expandir } from "./expandir.js";
import { carregarSinonimos } from "../db/semear.js";

export interface ResultadoImport {
  lidos: number;
  inseridos: number;
  atualizados: number;
  zerados: number;
}

const LOTE = 500;

export async function importarCatalogo(
  pool: Pool,
  caminho: string,
): Promise<ResultadoImport> {
  const { sharedStrings, sheet } = descompactar(readFileSync(caminho));
  validarCabecalho(sharedStrings, sheet);
  const linhas = parsearPlanilha(sharedStrings, sheet);
  if (linhas.length === 0) {
    throw new Error("Relatório sem nenhuma linha de produto — importação abortada");
  }

  const sinonimos = await carregarSinonimos(pool);
  const cliente = await pool.connect();

  try {
    await cliente.query("begin");

    const { rows: antes } = await cliente.query<{ codigo: string }>(
      "select codigo from agente.produtos",
    );
    const existentes = new Set(antes.map((r) => r.codigo));

    for (let i = 0; i < linhas.length; i += LOTE) {
      const lote = linhas.slice(i, i + LOTE);
      const valores: unknown[] = [];
      const marcadores = lote.map((l, n) => {
        const b = n * 5;
        valores.push(
          l.codigo,
          l.descricao,
          expandir(normalizar(l.descricao), sinonimos),
          l.unidade,
          l.estoque,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });

      await cliente.query(
        `insert into agente.produtos (codigo, descricao, descricao_norm, unidade, estoque)
         values ${marcadores.join(",")}
         on conflict (codigo) do update set
           descricao      = excluded.descricao,
           descricao_norm = excluded.descricao_norm,
           unidade        = excluded.unidade,
           estoque        = excluded.estoque,
           ativo          = true,
           atualizado_em  = now()`,
        valores,
      );
    }

    const presentes = linhas.map((l) => l.codigo);
    const { rowCount: zerados } = await cliente.query(
      `update agente.produtos
          set estoque = 0, atualizado_em = now()
        where estoque <> 0 and codigo <> all($1::text[])`,
      [presentes],
    );

    await cliente.query("commit");

    const inseridos = linhas.filter((l) => !existentes.has(l.codigo)).length;
    return {
      lidos: linhas.length,
      inseridos,
      atualizados: linhas.length - inseridos,
      zerados: zerados ?? 0,
    };
  } catch (erro) {
    await cliente.query("rollback");
    throw erro;
  } finally {
    cliente.release();
  }
}
