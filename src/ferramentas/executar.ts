import type { Pool } from "pg";
import { buscarPeca } from "../busca/buscar.js";
import { normalizar } from "../catalogo/normalizar.js";

export interface ContextoFerramenta {
  conversaId: string | null;
  contatoId: string | null;
}

/** Efeito colateral que o laço precisa conhecer para decidir se para. */
export type Efeito = { tipo: "handoff"; motivo: string; resumo: string };

/**
 * Diferença de score abaixo da qual duas opções são "parecidas demais".
 *
 * Veio da calibração: recall@1 é 82,5% e recall@3 é 100%, quase sempre porque
 * a loja tem o mesmo item de fabricantes diferentes, com score quase igual.
 * Nesses casos quem escolhe é o cliente, não o modelo.
 */
const MARGEM_AMBIGUIDADE = 0.05;

/** Acima disto o estoque é velho demais para afirmar sem conferir. */
const DIAS_PARA_CONFERIR = 7;

const MAX_OPCOES = 3;

async function ferramentaBuscarPeca(pool: Pool, entrada: any) {
  const achados = await buscarPeca(
    pool,
    String(entrada?.texto ?? ""),
    entrada?.moto_id ?? null,
  );
  const comEstoque = achados.filter((a) => a.estoque > 0);
  const top = comEstoque.slice(0, MAX_OPCOES);

  const ambiguo =
    top.length > 1 && Math.abs(top[0]!.score - top[1]!.score) < MARGEM_AMBIGUIDADE;

  return {
    // `estoque` e `score` ficam de fora de propósito: o que não entra no
    // contexto do modelo não pode ser dito ao cliente por engano.
    achados: top.map((a) => ({
      codigo: a.codigo,
      descricao: a.descricao,
      unidade: a.unidade,
      tem: true,
      fitment: a.fitment,
      confirmar_antes: a.diasSemAtualizar > DIAS_PARA_CONFERIR,
    })),
    ambiguo,
    // Distingue "não vendemos isso" de "vendemos mas está zerado": muda a
    // resposta ao cliente e o motivo em registrar_demanda.
    existe_sem_estoque: comEstoque.length === 0 && achados.length > 0,
  };
}

async function ferramentaIdentificarMoto(pool: Pool, entrada: any) {
  const texto = normalizar(String(entrada?.texto ?? "")).toLowerCase();
  if (texto === "") return { achou: false };

  const { rows } = await pool.query(
    `select id, marca, modelo, cilindrada, ano_ini, ano_fim
       from agente.motos
      where $1 like '%' || modelo || '%'
         or exists (select 1 from unnest(apelidos) ap where $1 like '%' || ap || '%')
      order by
        case when $1 like '%' || coalesce(cilindrada::text, '@') || '%' then 0 else 1 end,
        length(modelo) desc
      limit 1`,
    [texto],
  );

  const m = rows[0];
  if (!m) return { achou: false };
  return {
    achou: true,
    moto_id: m.id,
    marca: m.marca,
    modelo: m.modelo,
    cilindrada: m.cilindrada,
    anos: m.ano_ini && m.ano_fim ? `${m.ano_ini}-${m.ano_fim}` : null,
  };
}

/**
 * Executa a ferramenta que o modelo pediu.
 *
 * Nunca lança para o laço: erro vira resultado com `erro`, para o modelo
 * poder se recuperar ou transferir. Exceção que sobe daqui derruba o turno
 * inteiro e deixa o cliente sem resposta.
 */
export async function executarFerramenta(
  pool: Pool,
  ctx: ContextoFerramenta,
  nome: string,
  entrada: any,
): Promise<{ resultado: unknown; efeito?: Efeito }> {
  try {
    switch (nome) {
      case "buscar_peca":
        return { resultado: await ferramentaBuscarPeca(pool, entrada) };

      case "identificar_moto":
        return { resultado: await ferramentaIdentificarMoto(pool, entrada) };

      case "registrar_demanda": {
        await pool.query(
          `insert into agente.demanda_nao_atendida
             (conversa_id, texto_bruto, peca_norm, moto_id, motivo)
           values ($1,$2,$3,$4,$5)`,
          [
            ctx.conversaId,
            String(entrada?.texto_bruto ?? ""),
            entrada?.peca_norm ? normalizar(String(entrada.peca_norm)) : null,
            entrada?.moto_id ?? null,
            String(entrada?.motivo ?? "nao_cadastrado"),
          ],
        );
        return { resultado: { registrado: true } };
      }

      case "abrir_servico": {
        // A v1 não tem tabela de serviço: registrar como demanda mantém o
        // pedido visível ao dono e evita migração antes da hora.
        await pool.query(
          `insert into agente.demanda_nao_atendida
             (conversa_id, texto_bruto, peca_norm, moto_id, motivo)
           values ($1,$2,'SERVICO OFICINA',$3,'nao_trabalhamos')`,
          [
            ctx.conversaId,
            `OFICINA: ${String(entrada?.problema ?? "")} | preferência: ${String(entrada?.preferencia ?? "-")}`,
            entrada?.moto_id ?? null,
          ],
        );
        return { resultado: { registrado: true } };
      }

      case "transferir_humano": {
        const motivo = String(entrada?.motivo ?? "fora_escopo");
        const resumo = String(entrada?.resumo ?? "");
        if (ctx.conversaId) {
          await pool.query(
            `update agente.conversas
                set status = 'aguardando_humano', desfecho = 'handoff', resumo = $2
              where id = $1`,
            [ctx.conversaId, resumo],
          );
        }
        return {
          resultado: { transferido: true },
          efeito: { tipo: "handoff", motivo, resumo },
        };
      }

      default:
        return { resultado: { erro: `Ferramenta desconhecida: ${nome}` } };
    }
  } catch (erro) {
    return { resultado: { erro: `Falha ao executar ${nome}: ${(erro as Error).message}` } };
  }
}
