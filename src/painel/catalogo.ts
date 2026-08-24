import type { Pool } from "pg";
import { normalizar } from "../catalogo/normalizar.js";
import { expandir } from "../catalogo/expandir.js";
import { carregarSinonimos } from "../db/sinonimos.js";

/**
 * Catálogo pela mão do dono.
 *
 * Até aqui o catálogo só entrava por planilha do ERP, e o que o ERP não sabe
 * — preço, e qualquer peça comprada fora dele — simplesmente não existia. Aqui
 * o dono corrige estoque, digita preço e cadastra o que faltou, sem esperar o
 * próximo import.
 *
 * Preço em centavos, inteiro: `float` arredonda dinheiro e vira discussão no
 * balcão. A tela recebe e devolve centavos; quem formata em reais é ela.
 */

/** Teto de linhas por página. Alto o bastante para rolar, baixo para caber. */
const POR_PAGINA = 50;

export interface ProdutoPainel {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string | null;
  estoque: number;
  precoCentavos: number | null;
  ativo: boolean;
  origem: string;
  atualizadoEm: string;
  /** Quantas motos o balcão ou a extração já ligaram a esta peça. */
  motos: number;
  /** true quando alguém do balcão confirmou a compatibilidade à mão. */
  fitmentHumano: boolean;
}

export interface PaginaProdutos {
  itens: ProdutoPainel[];
  total: number;
  pagina: number;
  porPagina: number;
}

type FiltroProduto = "todos" | "sem_preco" | "sem_estoque" | "sem_fitment" | "inativos";

/**
 * Lista o catálogo com busca e filtro.
 *
 * A busca casa código e descrição normalizada, com a mesma normalização do
 * import — quem digita "titan150" acha "TITAN 150", que é como o ERP grava.
 */
export async function listarProdutos(
  pool: Pool,
  opcoes: { busca?: string; filtro?: FiltroProduto; pagina?: number } = {},
): Promise<PaginaProdutos> {
  const termo = normalizar(String(opcoes.busca ?? "")).trim();
  const filtro: FiltroProduto = opcoes.filtro ?? "todos";
  const pagina = Math.max(1, Math.floor(Number(opcoes.pagina ?? 1)) || 1);

  const condicoes: string[] = [];
  if (filtro === "inativos") condicoes.push("not p.ativo");
  else condicoes.push("p.ativo");

  if (filtro === "sem_preco") condicoes.push("p.preco_centavos is null");
  if (filtro === "sem_estoque") condicoes.push("p.estoque <= 0");
  if (filtro === "sem_fitment") {
    condicoes.push("not exists (select 1 from agente.produto_moto pm where pm.produto_id = p.id)");
  }
  if (termo !== "") {
    condicoes.push("(p.descricao_norm like '%' || $1 || '%' or p.codigo ilike '%' || $1 || '%')");
  }

  const onde = `where ${condicoes.join(" and ")}`;
  const parametros = termo !== "" ? [termo] : [];

  const { rows: contagem } = await pool.query<{ n: string }>(
    `select count(*)::text as n from agente.produtos p ${onde}`,
    parametros,
  );
  const total = Number(contagem[0]!.n);

  const { rows } = await pool.query(
    `select p.id, p.codigo, p.descricao, p.unidade, p.estoque, p.preco_centavos,
            p.ativo, p.origem, p.atualizado_em,
            (select count(*) from agente.produto_moto pm where pm.produto_id = p.id) as motos,
            exists (select 1 from agente.produto_moto pm
                     where pm.produto_id = p.id and pm.origem = 'humano') as fitment_humano
       from agente.produtos p
       ${onde}
      order by p.descricao asc
      limit ${POR_PAGINA} offset ${(pagina - 1) * POR_PAGINA}`,
    parametros,
  );

  return {
    itens: rows.map((r) => ({
      id: r.id,
      codigo: r.codigo,
      descricao: r.descricao,
      unidade: r.unidade,
      estoque: Number(r.estoque),
      precoCentavos: r.preco_centavos === null ? null : Number(r.preco_centavos),
      ativo: r.ativo,
      origem: r.origem,
      atualizadoEm: r.atualizado_em,
      motos: Number(r.motos),
      fitmentHumano: r.fitment_humano,
    })),
    total,
    pagina,
    porPagina: POR_PAGINA,
  };
}

export interface EntradaProduto {
  id?: string;
  codigo?: string;
  descricao?: string;
  unidade?: string | null;
  estoque?: number;
  precoCentavos?: number | null;
  ativo?: boolean;
}

/** Recusa o que quebraria a busca ou o balcão, com o motivo em português. */
function validarProduto(p: EntradaProduto, novo: boolean): string | null {
  if (novo || p.codigo !== undefined) {
    const codigo = String(p.codigo ?? "").trim();
    if (codigo === "") return "o código não pode ficar em branco";
    if (codigo.length > 40) return "código longo demais (máximo 40 caracteres)";
  }
  if (novo || p.descricao !== undefined) {
    const descricao = String(p.descricao ?? "").trim();
    if (descricao.length < 3) return "a descrição precisa de pelo menos 3 letras";
  }
  if (p.estoque !== undefined && (!Number.isInteger(p.estoque) || p.estoque < 0)) {
    return "estoque precisa ser um número inteiro, zero ou maior";
  }
  if (
    p.precoCentavos !== undefined &&
    p.precoCentavos !== null &&
    (!Number.isInteger(p.precoCentavos) || p.precoCentavos < 0)
  ) {
    return "preço inválido";
  }
  return null;
}

/**
 * Cria ou atualiza um produto.
 *
 * `descricao_norm` é recalculada aqui e não delegada ao banco de propósito:
 * é a mesma função que o import usa, e se as duas divergirem a peça editada
 * no painel deixa de ser encontrada pela busca.
 */
export async function salvarProduto(
  pool: Pool,
  entrada: EntradaProduto,
): Promise<{ ok: true; id: string } | { erro: string }> {
  const novo = !entrada.id;
  const problema = validarProduto(entrada, novo);
  if (problema) return { erro: problema };

  if (novo) {
    const descricao = String(entrada.descricao).trim();
    try {
      const { rows } = await pool.query<{ id: string }>(
        `insert into agente.produtos
           (codigo, descricao, descricao_norm, unidade, estoque, preco_centavos,
            ativo, origem, preco_atualizado_em, atualizado_em)
         values ($1, $2, $3, $4, $5, $6, $7, 'painel',
                 case when $6::int is null then null else now() end, now())
         returning id`,
        [
          String(entrada.codigo).trim(),
          descricao,
          normalizar(descricao),
          entrada.unidade?.trim() || null,
          entrada.estoque ?? 0,
          entrada.precoCentavos ?? null,
          entrada.ativo ?? true,
        ],
      );
      return { ok: true, id: rows[0]!.id };
    } catch (erro) {
      const mensagem = (erro as Error).message;
      if (mensagem.includes("produtos_codigo_key")) {
        return { erro: `já existe um produto com o código ${String(entrada.codigo).trim()}` };
      }
      return { erro: mensagem };
    }
  }

  // Update parcial: a tela salva uma célula por vez, e reenviar o registro
  // inteiro a cada tecla apagaria o que outro atendente acabou de mudar.
  const campos: string[] = [];
  const valores: unknown[] = [entrada.id];

  const por = (sql: string, valor: unknown) => {
    valores.push(valor);
    campos.push(`${sql} = $${valores.length}`);
  };

  if (entrada.codigo !== undefined) por("codigo", String(entrada.codigo).trim());
  if (entrada.descricao !== undefined) {
    const descricao = String(entrada.descricao).trim();
    por("descricao", descricao);
    por("descricao_norm", normalizar(descricao));
  }
  if (entrada.unidade !== undefined) por("unidade", entrada.unidade?.trim() || null);
  if (entrada.estoque !== undefined) por("estoque", entrada.estoque);
  if (entrada.ativo !== undefined) por("ativo", entrada.ativo);
  if (entrada.precoCentavos !== undefined) {
    por("preco_centavos", entrada.precoCentavos);
    campos.push("preco_atualizado_em = now()");
  }

  if (campos.length === 0) return { erro: "nada para alterar" };
  campos.push("atualizado_em = now()");

  try {
    const { rowCount } = await pool.query(
      `update agente.produtos set ${campos.join(", ")} where id = $1`,
      valores,
    );
    if (rowCount === 0) return { erro: "produto não encontrado" };
    return { ok: true, id: entrada.id! };
  } catch (erro) {
    const mensagem = (erro as Error).message;
    if (mensagem.includes("produtos_codigo_key")) return { erro: "esse código já é de outro produto" };
    return { erro: mensagem };
  }
}

/**
 * Tira o produto do catálogo sem apagar a linha.
 *
 * Apagar de verdade levaria junto o fitment que o balcão confirmou à mão e as
 * demandas ligadas a ele. Desativar some da busca e é reversível.
 */
export async function desativarProduto(
  pool: Pool,
  id: string,
  ativo: boolean,
): Promise<{ ok: true } | { erro: string }> {
  const { rowCount } = await pool.query(
    "update agente.produtos set ativo = $2, atualizado_em = now() where id = $1",
    [id, ativo],
  );
  return rowCount === 0 ? { erro: "produto não encontrado" } : { ok: true };
}

/** As motos ligadas a uma peça, para o balcão conferir a compatibilidade. */
export async function motosDoProduto(pool: Pool, produtoId: string) {
  const { rows } = await pool.query(
    `select m.id, m.marca, m.modelo, m.cilindrada, pm.origem, pm.confianca
       from agente.produto_moto pm
       join agente.motos m on m.id = pm.moto_id
      where pm.produto_id = $1
      order by pm.origem asc, m.marca, m.modelo`,
    [produtoId],
  );
  return rows.map((r) => ({
    id: r.id,
    nome: `${r.marca} ${r.modelo}${r.cilindrada ? " " + r.cilindrada : ""}`,
    origem: r.origem as "auto" | "humano",
    confianca: r.confianca === null ? null : Number(r.confianca),
  }));
}

/**
 * Confirma ou remove a compatibilidade de uma peça com uma moto.
 *
 * Confirmar é a única coisa que autoriza o agente a afirmar que a peça serve
 * — `fitment: humano` é a regra 3 do prompt. Por isso mora no painel: quem
 * responde pelo que foi dito ao cliente é o balcão, não a extração automática.
 */
export async function confirmarFitment(
  pool: Pool,
  produtoId: string,
  motoId: string,
  confirmado: boolean,
): Promise<{ ok: true } | { erro: string }> {
  if (!confirmado) {
    await pool.query(
      "delete from agente.produto_moto where produto_id = $1 and moto_id = $2",
      [produtoId, motoId],
    );
    return { ok: true };
  }

  try {
    await pool.query(
      `insert into agente.produto_moto (produto_id, moto_id, origem, confianca)
       values ($1, $2, 'humano', 1)
       on conflict (produto_id, moto_id)
         do update set origem = 'humano', confianca = 1`,
      [produtoId, motoId],
    );
    return { ok: true };
  } catch (erro) {
    return { erro: (erro as Error).message };
  }
}

/** Motos cadastradas, para o campo de busca do fitment. */
export async function listarMotos(pool: Pool, busca = "") {
  const termo = normalizar(busca).trim().toLowerCase();
  const { rows } = await pool.query(
    `select id, marca, modelo, cilindrada, ano_ini, ano_fim
       from agente.motos
      where $1 = '' or lower(modelo) like '%' || $1 || '%' or lower(marca) like '%' || $1 || '%'
      order by marca, modelo, cilindrada
      limit 60`,
    [termo],
  );
  return rows.map((r) => ({
    id: r.id,
    nome: `${r.marca} ${r.modelo}${r.cilindrada ? " " + r.cilindrada : ""}`,
    anos: r.ano_ini && r.ano_fim ? `${r.ano_ini}-${r.ano_fim}` : null,
  }));
}

// ---------------------------------------------------------------- serviços

export interface ServicoPainel {
  id: string;
  nome: string;
  descricao: string | null;
  precoCentavos: number | null;
  duracaoMin: number | null;
  ativo: boolean;
  atualizadoEm: string;
}

export async function listarServicos(pool: Pool, busca = ""): Promise<ServicoPainel[]> {
  const termo = normalizar(busca).trim();
  const { rows } = await pool.query(
    `select id, nome, descricao, preco_centavos, duracao_min, ativo, atualizado_em
       from agente.servicos
      where $1 = '' or nome_norm like '%' || $1 || '%'
      order by ativo desc, nome asc`,
    [termo],
  );
  return rows.map((r) => ({
    id: r.id,
    nome: r.nome,
    descricao: r.descricao,
    precoCentavos: r.preco_centavos === null ? null : Number(r.preco_centavos),
    duracaoMin: r.duracao_min === null ? null : Number(r.duracao_min),
    ativo: r.ativo,
    atualizadoEm: r.atualizado_em,
  }));
}

export interface EntradaServico {
  id?: string;
  nome?: string;
  descricao?: string | null;
  precoCentavos?: number | null;
  duracaoMin?: number | null;
  ativo?: boolean;
}

export async function salvarServico(
  pool: Pool,
  entrada: EntradaServico,
): Promise<{ ok: true; id: string } | { erro: string }> {
  const novo = !entrada.id;

  if ((novo || entrada.nome !== undefined) && String(entrada.nome ?? "").trim().length < 3) {
    return { erro: "o nome do serviço precisa de pelo menos 3 letras" };
  }
  if (
    entrada.precoCentavos !== undefined &&
    entrada.precoCentavos !== null &&
    (!Number.isInteger(entrada.precoCentavos) || entrada.precoCentavos < 0)
  ) {
    return { erro: "preço inválido" };
  }
  if (
    entrada.duracaoMin !== undefined &&
    entrada.duracaoMin !== null &&
    (!Number.isInteger(entrada.duracaoMin) || entrada.duracaoMin <= 0)
  ) {
    return { erro: "duração precisa ser um número de minutos maior que zero" };
  }

  try {
    if (novo) {
      const nome = String(entrada.nome).trim();
      const { rows } = await pool.query<{ id: string }>(
        `insert into agente.servicos (nome, nome_norm, descricao, preco_centavos, duracao_min, ativo)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          nome,
          normalizar(nome),
          entrada.descricao?.trim() || null,
          entrada.precoCentavos ?? null,
          entrada.duracaoMin ?? null,
          entrada.ativo ?? true,
        ],
      );
      return { ok: true, id: rows[0]!.id };
    }

    const campos: string[] = [];
    const valores: unknown[] = [entrada.id];
    const por = (sql: string, valor: unknown) => {
      valores.push(valor);
      campos.push(`${sql} = $${valores.length}`);
    };

    if (entrada.nome !== undefined) {
      const nome = String(entrada.nome).trim();
      por("nome", nome);
      por("nome_norm", normalizar(nome));
    }
    if (entrada.descricao !== undefined) por("descricao", entrada.descricao?.trim() || null);
    if (entrada.precoCentavos !== undefined) por("preco_centavos", entrada.precoCentavos);
    if (entrada.duracaoMin !== undefined) por("duracao_min", entrada.duracaoMin);
    if (entrada.ativo !== undefined) por("ativo", entrada.ativo);

    if (campos.length === 0) return { erro: "nada para alterar" };
    campos.push("atualizado_em = now()");

    const { rowCount } = await pool.query(
      `update agente.servicos set ${campos.join(", ")} where id = $1`,
      valores,
    );
    if (rowCount === 0) return { erro: "serviço não encontrado" };
    return { ok: true, id: entrada.id! };
  } catch (erro) {
    const mensagem = (erro as Error).message;
    if (mensagem.includes("servicos_nome_norm")) return { erro: "já existe um serviço com esse nome" };
    return { erro: mensagem };
  }
}

export async function excluirServico(
  pool: Pool,
  id: string,
): Promise<{ ok: true } | { erro: string }> {
  const { rowCount } = await pool.query("delete from agente.servicos where id = $1", [id]);
  return rowCount === 0 ? { erro: "serviço não encontrado" } : { ok: true };
}

/**
 * Confere se o texto de uma peça é encontrável pela busca do agente.
 *
 * Cadastrar peça no painel e ela não aparecer para o cliente é o erro que só
 * se descobre semanas depois, por uma venda perdida. Aqui o dono vê na hora
 * como o texto foi normalizado e expandido — os dois passos que a busca usa.
 */
export async function prever(pool: Pool, texto: string) {
  const sinonimos = await carregarSinonimos(pool);
  const norm = normalizar(texto);
  return { normalizado: norm, expandido: expandir(norm, sinonimos) };
}
