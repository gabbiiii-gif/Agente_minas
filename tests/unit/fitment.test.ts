import { describe, expect, it } from "vitest";
import { casarComFrota, type LinhaMoto } from "../../src/catalogo/fitment.js";

const FROTA: LinhaMoto[] = [
  { id: "m1", marca: "honda", modelo: "titan", cilindrada: 150,
    apelidos: ["titan 150", "titam 150", "cg150"] },
  { id: "m2", marca: "honda", modelo: "titan", cilindrada: 160,
    apelidos: ["titan 160", "cg160"] },
  { id: "m3", marca: "honda", modelo: "biz",   cilindrada: 125, apelidos: ["biz 125"] },
  { id: "m4", marca: "honda", modelo: "bros",  cilindrada: 150,
    apelidos: ["nxr150", "nxr 150", "bros 150"] },
  { id: "m5", marca: "honda", modelo: "bros",  cilindrada: 125,
    apelidos: ["nxr125", "nxr 125", "bros 125"] },
  { id: "m6", marca: "suzuki", modelo: "intruder", cilindrada: 125,
    apelidos: ["intrunder 125", "intruder"] },
];

/** Só os ids, para as asserções que não se importam com o tipo do casamento. */
const ids = (r: ReturnType<typeof casarComFrota>) => r.map((c) => c.motoId).sort();

describe("casarComFrota", () => {
  it("casa modelo e cilindrada exatos", () => {
    expect(ids(casarComFrota([{ modelo: "titan", cilindrada: 160 }], FROTA))).toEqual(["m2"]);
  });

  it("casa todas as cilindradas quando a descrição não diz qual", () => {
    expect(ids(casarComFrota([{ modelo: "titan", cilindrada: null }], FROTA)))
      .toEqual(["m1", "m2"]);
  });

  it("casa vários modelos de uma descrição só", () => {
    const r = casarComFrota(
      [{ modelo: "biz", cilindrada: 125 }, { modelo: "bros", cilindrada: 150 }],
      FROTA,
    );
    expect(ids(r)).toEqual(["m3", "m4"]);
  });

  it("casa o apelido do estoque, não só o nome oficial do modelo", () => {
    // A loja escreve NXR e nunca Bros: sem isto, 976 peças ficavam sem moto.
    expect(ids(casarComFrota([{ modelo: "nxr", cilindrada: 150 }], FROTA))).toEqual(["m4"]);
  });

  it("apelido sem cilindrada vale para todas as cilindradas do modelo", () => {
    // "CARENAGEM NXR" sem número serve tanto na 125 quanto na 150.
    expect(ids(casarComFrota([{ modelo: "nxr", cilindrada: null }], FROTA)))
      .toEqual(["m4", "m5"]);
  });

  it("casa a grafia errada que o ERP usa", () => {
    expect(ids(casarComFrota([{ modelo: "titam", cilindrada: 150 }], FROTA))).toEqual(["m1"]);
    expect(ids(casarComFrota([{ modelo: "intrunder", cilindrada: 125 }], FROTA))).toEqual(["m6"]);
  });

  it("apelido não confunde cilindradas diferentes do mesmo apelido", () => {
    // "cg150" e "cg160" viram os dois o nome "cg"; a cilindrada desempata.
    expect(ids(casarComFrota([{ modelo: "cg", cilindrada: 160 }], FROTA))).toEqual(["m2"]);
  });

  it("descarta modelo que não está na frota cadastrada", () => {
    expect(ids(casarComFrota([{ modelo: "cbr", cilindrada: 1000 }], FROTA))).toEqual([]);
  });

  it("não repete o mesmo id", () => {
    const r = casarComFrota(
      [{ modelo: "titan", cilindrada: 160 }, { modelo: "titan", cilindrada: 160 }],
      FROTA,
    );
    expect(r).toEqual([{ motoId: "m2", exato: true }]);
  });

  it("marca como exato quando a descrição diz a cilindrada", () => {
    // "PISTAO SPEED150": o ERP escreveu o número e ele bate. O agente pode
    // afirmar que serve.
    expect(casarComFrota([{ modelo: "titan", cilindrada: 160 }], FROTA))
      .toEqual([{ motoId: "m2", exato: true }]);
  });

  it("não marca como exato o que a regra deduziu do modelo sem número", () => {
    // "PISTAO TITAN" espalha para 150 e 160. É aqui que nasce o vínculo errado
    // ("DESCANSO XT/TDM225" caindo na Ténéré 600), então o agente hedgeia.
    const r = casarComFrota([{ modelo: "titan", cilindrada: null }], FROTA);
    expect(r.every((c) => c.exato === false)).toBe(true);
  });

  it("a evidência mais forte manda quando a peça casa pelas duas vias", () => {
    // "CAPA TITAN/TITAN160" alcança a 160 por omissão e por número. Vale exato.
    const r = casarComFrota(
      [{ modelo: "titan", cilindrada: null }, { modelo: "titan", cilindrada: 160 }],
      FROTA,
    );
    expect(r.find((c) => c.motoId === "m2")?.exato).toBe(true);
    expect(r.find((c) => c.motoId === "m1")?.exato).toBe(false);
  });
});
