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

const LINHA_CABECALHO = "4";

const RE_ITEM = /<x:si>(.*?)<\/x:si>/gs;
const RE_TEXTO = /<x:t[^>]*>(.*?)<\/x:t>/gs;
const RE_LINHA = /<x:row[^>]*r="(\d+)"[^>]*>(.*?)<\/x:row>/gs;
const RE_CELULA = /<x:c r="([A-Z]+)\d+"([^>]*)>(?:<x:v>(.*?)<\/x:v>)?/gs;

function lerSharedStrings(xml: string): string[] {
  return [...xml.matchAll(RE_ITEM)].map((item) =>
    [...item[1]!.matchAll(RE_TEXTO)].map((t) => t[1]!).join(""),
  );
}

function lerLinhas(
  sheetXml: string,
  strs: string[],
): Array<{ numero: string; celulas: Record<string, string> }> {
  return [...sheetXml.matchAll(RE_LINHA)].map((linha) => {
    const celulas: Record<string, string> = {};
    for (const c of linha[2]!.matchAll(RE_CELULA)) {
      const coluna = c[1]!;
      const bruto = c[3];
      if (bruto === undefined) continue;
      const ehTexto = /t="s"/.test(c[2]!);
      celulas[coluna] = ehTexto ? (strs[Number(bruto)] ?? "") : bruto;
    }
    return { numero: linha[1]!, celulas };
  });
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
    [COLUNAS.codigo, "Código"],
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

export function parsearPlanilha(
  sharedStringsXml: string,
  sheetXml: string,
): LinhaEstoque[] {
  const strs = lerSharedStrings(sharedStringsXml);
  const linhas: LinhaEstoque[] = [];

  for (const { numero, celulas } of lerLinhas(sheetXml, strs)) {
    if (numero === LINHA_CABECALHO) continue;
    const codigo = (celulas[COLUNAS.codigo] ?? "").trim();
    const descricao = (celulas[COLUNAS.descricao] ?? "").trim();
    if (!/^\d+$/.test(codigo) || descricao === "") continue;

    linhas.push({
      codigo,
      descricao,
      unidade: (celulas[COLUNAS.unidade] ?? "UND").trim(),
      estoque: Number.parseInt(celulas[COLUNAS.estoque] ?? "0", 10) || 0,
    });
  }

  return linhas;
}
