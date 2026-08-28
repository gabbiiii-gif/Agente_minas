import { describe, expect, it } from "vitest";
import { parsearPlanilha, validarCabecalho } from "../../src/catalogo/planilha.js";

const textos = [
  "Código",                                            // 0
  "Produto",                                           // 1
  "Unid.",                                             // 2
  "Estoque",                                           // 3
  "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA", // 4
  "UND",                                               // 5
  "PROTETOR BRACO CAMBIO CORES ROSENDO",               // 6
  "PAR",                                               // 7
  "B8ES",                                              // 8  código de fabricante
  "VELA IGNICAO B8ES NGK",                             // 9
  "18D-F472-71K-",                                     // 10 código quebrado…
  "00-P3",                                             // 11 …e sua continuação
  "RABETA YBR FACTOR 09/13 ROXA YAMAHA",               // 12
  "KIT",                                               // 13
  "Relatório de Estoque - Normal",                     // 14 mobília de página
  "Total de Registros :",                              // 15
];

const SHARED = `<?xml version="1.0"?><x:sst xmlns:x="s">${textos
  .map((t) => `<x:si><x:t>${t}</x:t></x:si>`)
  .join("")}</x:sst>`;

/** `s:4` → célula de texto apontando para sharedStrings[4]; `n:7` → número cru. */
function linha(numero: number, celulas: Record<string, string>): string {
  const cs = Object.entries(celulas)
    .map(([col, v]) => {
      const [tipo, valor] = v.split(":");
      const t = tipo === "s" ? ' t="s"' : "";
      return `<x:c r="${col}${numero}"${t}><x:v>${valor}</x:v></x:c>`;
    })
    .join("");
  return `<x:row r="${numero}">${cs}</x:row>`;
}

function planilha(linhas: string[]): string {
  return `<?xml version="1.0"?><x:worksheet xmlns:x="s"><x:sheetData>${linhas.join(
    "",
  )}</x:sheetData></x:worksheet>`;
}

const CABECALHO = linha(4, { A: "s:0", D: "s:1", J: "s:2", Q: "s:3" });

const SHEET = planilha([
  CABECALHO,
  linha(6, { A: "n:1", D: "s:4", J: "s:5", Q: "n:1" }),
  linha(7, { A: "n:27", D: "s:6", J: "s:7", Q: "n:2" }),
  linha(8, { A: "n:99", J: "s:5", Q: "n:4" }), // sem descrição
  linha(9, { A: "s:8", D: "s:9", J: "s:5", Q: "n:12" }), // código alfanumérico
  linha(10, { A: "s:10", D: "s:12", J: "s:13", Q: "n:2" }), // código quebrado
  linha(11, { A: "s:11" }), // continuação do código da linha 10
  linha(12, { A: "s:14" }), // mobília: título de página nova
  CABECALHO.replace(/r="([A-Z])4"/g, 'r="$113"').replace('r="4"', 'r="13"'),
  linha(14, { F: "s:15", H: "n:4" }), // rodapé com o total do ERP
]);

describe("parsearPlanilha", () => {
  const linhas = parsearPlanilha(SHARED, SHEET);

  it("lê código, descrição, unidade e estoque", () => {
    expect(linhas[0]).toEqual({
      codigo: "1",
      descricao: "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA",
      unidade: "UND",
      estoque: 1,
    });
  });

  it("descarta linha sem descrição", () => {
    expect(linhas.find((l) => l.codigo === "99")).toBeUndefined();
  });

  it("aceita código de fabricante, não só sequencial", () => {
    // O filtro `^\d+$` antigo deixava 3.597 peças reais de fora, caladas.
    expect(linhas.find((l) => l.codigo === "B8ES")?.descricao).toBe(
      "VELA IGNICAO B8ES NGK",
    );
  });

  it("remonta código derramado na linha seguinte", () => {
    // O ERP não trunca: joga o resto do código numa linha só com a coluna A.
    expect(linhas.find((l) => l.descricao.startsWith("RABETA"))?.codigo).toBe(
      "18D-F472-71K-00-P3",
    );
  });

  it("ignora o cabeçalho que o ERP repete a cada página", () => {
    expect(linhas.some((l) => l.codigo === "Código")).toBe(false);
  });

  it("recusa quando o total lido não bate com o rodapé do ERP", () => {
    // Uma peça a mais no rodapé significa parse incompleto: aborta em vez de
    // importar meio catálogo em silêncio.
    const mentiroso = SHEET.replace('r="H14"><x:v>4', 'r="H14"><x:v>9');
    expect(() => parsearPlanilha(SHARED, mentiroso)).toThrow(
      "Relatório declara 9 registros",
    );
  });
});

describe("validarCabecalho", () => {
  it("aceita o layout esperado", () => {
    expect(() => validarCabecalho(SHARED, SHEET)).not.toThrow();
  });

  it("recusa quando a coluna do produto mudou de lugar", () => {
    const trocado = SHEET.replace('r="D4"', 'r="E4"');
    expect(() => validarCabecalho(SHARED, trocado)).toThrow(
      "Layout do relatório mudou",
    );
  });
});
