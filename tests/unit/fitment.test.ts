import { describe, expect, it } from "vitest";
import { casarComFrota, type LinhaMoto } from "../../src/catalogo/fitment.js";

const FROTA: LinhaMoto[] = [
  { id: "m1", marca: "honda", modelo: "titan", cilindrada: 150 },
  { id: "m2", marca: "honda", modelo: "titan", cilindrada: 160 },
  { id: "m3", marca: "honda", modelo: "biz",   cilindrada: 125 },
  { id: "m4", marca: "honda", modelo: "bros",  cilindrada: 150 },
];

describe("casarComFrota", () => {
  it("casa modelo e cilindrada exatos", () => {
    expect(casarComFrota([{ modelo: "titan", cilindrada: 160 }], FROTA)).toEqual(["m2"]);
  });

  it("casa todas as cilindradas quando a descrição não diz qual", () => {
    expect(casarComFrota([{ modelo: "titan", cilindrada: null }], FROTA).sort())
      .toEqual(["m1", "m2"]);
  });

  it("casa vários modelos de uma descrição só", () => {
    const r = casarComFrota(
      [{ modelo: "biz", cilindrada: 125 }, { modelo: "bros", cilindrada: 150 }],
      FROTA,
    );
    expect(r.sort()).toEqual(["m3", "m4"]);
  });

  it("descarta modelo que não está na frota cadastrada", () => {
    expect(casarComFrota([{ modelo: "cbr", cilindrada: 1000 }], FROTA)).toEqual([]);
  });

  it("não repete o mesmo id", () => {
    const r = casarComFrota(
      [{ modelo: "titan", cilindrada: 160 }, { modelo: "titan", cilindrada: 160 }],
      FROTA,
    );
    expect(r).toEqual(["m2"]);
  });
});
