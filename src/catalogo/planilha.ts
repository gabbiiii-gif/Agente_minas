import { unzipSync, strFromU8 } from "fflate";

export interface LinhaEstoque {
  codigo: string;
  descricao: string;
  unidade: string;
  estoque: number;
}

/** Colunas do relatório "Estoque - Normal" do ERP. */
const COLUNAS = {
  codigo: "A",
  descricao: "D",
  unidade: "J",
  estoque: "Q",
} as const;

const LINHA_CABECALHO = 4;

// O relatório sai paginado: a cada ~47 linhas o ERP repete o título, "Empresa:",
// "Filial:" e a própria linha de cabeçalho. São 222 páginas neste arquivo. A
// linha de cabeçalho repetida tem código, produto e unidade preenchidos, então
// só o texto do título a distingue de um produto de verdade.
const TITULO_CODIGO = "Código";

// Rodapé que o ERP imprime na última linha, com a contagem que ele mesmo
// apurou. É o nosso checksum contra parse silenciosamente incompleto.
const ROTULO_TOTAL = "Total de Registros";

const RE_ITEM = /<x:si>(.*?)<\/x:si>/gs;
const RE_TEXTO = /<x:t[^>]*>(.*?)<\/x:t>/gs;
const RE_LINHA = /<x:row[^>]*r="(\d+)"[^>]*>(.*?)<\/x:row>/gs;
const RE_CELULA = /<x:c r="([A-Z]+)\d+"([^>]*)>(?:<x:v>(.*?)<\/x:v>)?/gs;

interface Linha {
  numero: number;
  celulas: Record<string, string>;
}

function lerSharedStrings(xml: string): string[] {
  return [...xml.matchAll(RE_ITEM)].map((item) =>
    [...item[1]!.matchAll(RE_TEXTO)].map((t) => t[1]!).join(""),
  );
}

function lerLinhas(sheetXml: string, strs: string[]): Linha[] {
  return [...sheetXml.matchAll(RE_LINHA)].map((linha) => {
    const celulas: Record<string, string> = {};
    for (const c of linha[2]!.matchAll(RE_CELULA)) {
      const coluna = c[1]!;
      const bruto = c[3];
      if (bruto === undefined) continue;
      const ehTexto = /t="s"/.test(c[2]!);
      const valor = ehTexto ? (strs[Number(bruto)] ?? "") : bruto;
      if (valor.trim() !== "") celulas[coluna] = valor;
    }
    return { numero: Number(linha[1]!), celulas };
  });
}

/**
 * Linha que continua o código da linha anterior.
 *
 * O ERP não quebra o código na largura da coluna: ele derrama o resto numa
 * linha inteira só com a coluna A. Foi o que escondeu 147 produtos —
 * "18D-F472-71K-" e "00-P3" são a mesma peça, e três produtos diferentes
 * apareciam como o mesmo código truncado "18D-F137W-00-".
 */
function ehContinuacao(linha: Linha | undefined): boolean {
  if (!linha) return false;
  const preenchidas = Object.keys(linha.celulas);
  if (preenchidas.length !== 1 || preenchidas[0] !== COLUNAS.codigo) return false;
  // Título de página ("Relatório de Estoque - Normal") também ocupa só a coluna
  // A. Fragmento de código nunca tem espaço; mobília sempre tem.
  return !/\s/.test(linha.celulas[COLUNAS.codigo]!.trim());
}

/** Linha de produto de verdade: código, descrição e unidade, e não o cabeçalho repetido. */
function ehProduto(celulas: Record<string, string>): boolean {
  const codigo = (celulas[COLUNAS.codigo] ?? "").trim();
  if (codigo === "" || codigo === TITULO_CODIGO) return false;
  return (
    (celulas[COLUNAS.descricao] ?? "").trim() !== "" &&
    (celulas[COLUNAS.unidade] ?? "").trim() !== ""
  );
}

/**
 * Total que o próprio ERP declara no rodapé, ou null se o rodapé sumir.
 *
 * O rótulo mora numa coluna e o número na seguinte; procuramos pelo texto em
 * vez de fixar a coluna para o checksum sobreviver a um ajuste de layout.
 */
function totalDeclarado(linhas: Linha[]): number | null {
  for (const { celulas } of linhas) {
    const colunas = Object.keys(celulas).sort();
    const i = colunas.findIndex((c) => celulas[c]!.includes(ROTULO_TOTAL));
    if (i === -1) continue;
    for (const coluna of colunas.slice(i + 1)) {
      const n = Number(celulas[coluna]);
      if (Number.isInteger(n)) return n;
    }
  }
  return null;
}

export function descompactar(buffer: Uint8Array): {
  sharedStrings: string;
  sheet: string;
} {
  const arquivos = unzipSync(buffer);
  const nomeSheet = Object.keys(arquivos).find((n) =>
    /^xl\/worksheets\/.*\.xml$/.test(n),
  );
  const nomeShared = "xl/sharedStrings.xml";
  if (!nomeSheet || !arquivos[nomeShared]) {
    throw new Error(
      "Arquivo não parece um relatório do ERP: falta planilha ou sharedStrings",
    );
  }
  return {
    sharedStrings: strFromU8(arquivos[nomeShared]!),
    sheet: strFromU8(arquivos[nomeSheet]!),
  };
}

/** Falha alto e cedo se o ERP mudar a ordem das colunas. */
export function validarCabecalho(
  sharedStringsXml: string,
  sheetXml: string,
): void {
  const strs = lerSharedStrings(sharedStringsXml);
  const cabecalho = lerLinhas(sheetXml, strs).find(
    (l) => l.numero === LINHA_CABECALHO,
  );
  if (!cabecalho) {
    throw new Error(
      `Layout do relatório mudou: linha ${LINHA_CABECALHO} não encontrada`,
    );
  }
  const esperado: Array<[string, string]> = [
    [COLUNAS.codigo, TITULO_CODIGO],
    [COLUNAS.descricao, "Produto"],
    [COLUNAS.unidade, "Unid."],
    [COLUNAS.estoque, "Estoque"],
  ];
  for (const [coluna, titulo] of esperado) {
    if (cabecalho.celulas[coluna] !== titulo) {
      throw new Error(
        `Layout do relatório mudou: esperava "${titulo}" na coluna ${coluna}, veio "${cabecalho.celulas[coluna] ?? ""}"`,
      );
    }
  }
}

/**
 * Extrai as linhas de produto do relatório paginado do ERP.
 *
 * Aceita código alfanumérico: metade do estoque tem código de fabricante
 * ("N14", "B8ES", "18D-F472-71K-00-P3") e não um número sequencial. Filtrar por
 * `^\d+$` deixava 3.597 peças de fora sem avisar ninguém.
 *
 * Confere o resultado contra o "Total de Registros" do rodapé e falha se
 * divergir — é a única defesa contra voltar a importar meio catálogo em
 * silêncio.
 */
export function parsearPlanilha(
  sharedStringsXml: string,
  sheetXml: string,
): LinhaEstoque[] {
  const strs = lerSharedStrings(sharedStringsXml);
  const todas = lerLinhas(sheetXml, strs);
  const porNumero = new Map(todas.map((l) => [l.numero, l]));
  const linhas: LinhaEstoque[] = [];

  for (const { numero, celulas } of todas) {
    if (!ehProduto(celulas)) continue;

    let codigo = celulas[COLUNAS.codigo]!.trim();
    for (let n = numero + 1; ehContinuacao(porNumero.get(n)); n++) {
      codigo += porNumero.get(n)!.celulas[COLUNAS.codigo]!.trim();
    }

    linhas.push({
      codigo,
      descricao: celulas[COLUNAS.descricao]!.trim(),
      unidade: (celulas[COLUNAS.unidade] ?? "UND").trim(),
      estoque: Number.parseInt(celulas[COLUNAS.estoque] ?? "0", 10) || 0,
    });
  }

  const declarado = totalDeclarado(todas);
  if (declarado !== null && declarado !== linhas.length) {
    throw new Error(
      `Relatório declara ${declarado} registros no rodapé, mas o parser leu ${linhas.length} — importação abortada`,
    );
  }

  return linhas;
}
