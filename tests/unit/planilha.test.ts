import { describe, expect, it } from "vitest";
import { parsearPlanilha, validarCabecalho } from "../../src/catalogo/planilha.js";

const SHARED = `<?xml version="1.0"?><x:sst xmlns:x="s">
<x:si><x:t>Código</x:t></x:si>
<x:si><x:t>Produto</x:t></x:si>
<x:si><x:t>Unid.</x:t></x:si>
<x:si><x:t>Estoque</x:t></x:si>
<x:si><x:t>ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA</x:t></x:si>
<x:si><x:t>UND</x:t></x:si>
<x:si><x:t>PROTETOR BRACO CAMBIO CORES ROSENDO</x:t></x:si>
<x:si><x:t>PAR</x:t></x:si>
</x:sst>`;

const SHEET = `<?xml version="1.0"?><x:worksheet xmlns:x="s"><x:sheetData>
<x:row r="4"><x:c r="A4" t="s"><x:v>0</x:v></x:c><x:c r="D4" t="s"><x:v>1</x:v></x:c><x:c r="J4" t="s"><x:v>2</x:v></x:c><x:c r="Q4" t="s"><x:v>3</x:v></x:c></x:row>
<x:row r="6"><x:c r="A6"><x:v>1</x:v></x:c><x:c r="D6" t="s"><x:v>4</x:v></x:c><x:c r="J6" t="s"><x:v>5</x:v></x:c><x:c r="Q6"><x:v>1</x:v></x:c></x:row>
<x:row r="7"><x:c r="A7"><x:v>27</x:v></x:c><x:c r="D7" t="s"><x:v>6</x:v></x:c><x:c r="J7" t="s"><x:v>7</x:v></x:c><x:c r="Q7"><x:v>2</x:v></x:c></x:row>
<x:row r="8"><x:c r="A8"><x:v>99</x:v></x:c><x:c r="J8" t="s"><x:v>5</x:v></x:c><x:c r="Q8"><x:v>4</x:v></x:c></x:row>
</x:sheetData></x:worksheet>`;

describe("parsearPlanilha", () => {
  it("lê código, descrição, unidade e estoque", () => {
    const linhas = parsearPlanilha(SHARED, SHEET);
    expect(linhas).toEqual([
      {
        codigo: "1",
        descricao: "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA",
        unidade: "UND",
        estoque: 1,
      },
      {
        codigo: "27",
        descricao: "PROTETOR BRACO CAMBIO CORES ROSENDO",
        unidade: "PAR",
        estoque: 2,
      },
    ]);
  });

  it("descarta linha sem descrição", () => {
    const linhas = parsearPlanilha(SHARED, SHEET);
    expect(linhas.find((l) => l.codigo === "99")).toBeUndefined();
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
