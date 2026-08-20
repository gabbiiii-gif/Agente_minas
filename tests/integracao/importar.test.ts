import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import { semear } from "../../src/db/semear.js";
import { importarCatalogo } from "../../src/catalogo/importar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

function planilhaFalsa(itens: Array<[string, string, string, number]>): Uint8Array {
  const strs = ["Código", "Produto", "Unid.", "Estoque"];
  const idx = (s: string) => {
    const i = strs.indexOf(s);
    if (i >= 0) return i;
    strs.push(s);
    return strs.length - 1;
  };
  const corpo = itens
    .map(([cod, desc, un, est], n) => {
      const r = 6 + n;
      return `<x:row r="${r}"><x:c r="A${r}"><x:v>${cod}</x:v></x:c><x:c r="D${r}" t="s"><x:v>${idx(desc)}</x:v></x:c><x:c r="J${r}" t="s"><x:v>${idx(un)}</x:v></x:c><x:c r="Q${r}"><x:v>${est}</x:v></x:c></x:row>`;
    })
    .join("");
  const cabecalho = `<x:row r="4"><x:c r="A4" t="s"><x:v>0</x:v></x:c><x:c r="D4" t="s"><x:v>1</x:v></x:c><x:c r="J4" t="s"><x:v>2</x:v></x:c><x:c r="Q4" t="s"><x:v>3</x:v></x:c></x:row>`;
  const sheet = `<?xml version="1.0"?><x:worksheet xmlns:x="s"><x:sheetData>${cabecalho}${corpo}</x:sheetData></x:worksheet>`;
  const shared = `<?xml version="1.0"?><x:sst xmlns:x="s">${strs.map((s) => `<x:si><x:t>${s}</x:t></x:si>`).join("")}</x:sst>`;
  return zipSync({
    "xl/sharedStrings.xml": strToU8(shared),
    "xl/worksheets/sheet.xml": strToU8(sheet),
  });
}

descrever("importarCatalogo", () => {
  let pool: Pool;
  let dir: string;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await semear(pool);
    dir = mkdtempSync(join(tmpdir(), "cat-"));
    await pool.query("delete from agente.produtos");
  });

  afterAll(async () => {
    await pool.query("delete from agente.produtos where codigo like '999%'");
    await pool.end();
  });

  it("insere produtos e grava a descrição normalizada e expandida", async () => {
    const caminho = join(dir, "a.xlsx");
    writeFileSync(caminho, planilhaFalsa([
      ["9990001", "RET DIANT. TITAN160 VEDAMOTORS", "UND", 3],
      ["9990002", "PASTILHA FREIO TRAS. CG160 25 FABRECK", "UND", 19],
    ]));

    const r = await importarCatalogo(pool, caminho);
    expect(r.lidos).toBe(2);
    expect(r.inseridos).toBe(2);

    const { rows } = await pool.query<{ descricao_norm: string; estoque: number }>(
      "select descricao_norm, estoque from agente.produtos where codigo = '9990001'",
    );
    expect(rows[0]!.descricao_norm).toBe("RETENTOR DIANTEIRO TITAN160 VEDAMOTORS");
    expect(rows[0]!.estoque).toBe(3);
  });

  it("atualiza estoque na segunda importação", async () => {
    const caminho = join(dir, "b.xlsx");
    writeFileSync(caminho, planilhaFalsa([
      ["9990001", "RET DIANT. TITAN160 VEDAMOTORS", "UND", 7],
    ]));

    const r = await importarCatalogo(pool, caminho);
    expect(r.atualizados).toBe(1);

    const { rows } = await pool.query<{ estoque: number }>(
      "select estoque from agente.produtos where codigo = '9990001'",
    );
    expect(rows[0]!.estoque).toBe(7);
  });

  it("zera estoque de código ausente sem desativar o produto", async () => {
    const { rows } = await pool.query<{ estoque: number; ativo: boolean }>(
      "select estoque, ativo from agente.produtos where codigo = '9990002'",
    );
    expect(rows[0]!.estoque).toBe(0);
    expect(rows[0]!.ativo).toBe(true);
  });
});
