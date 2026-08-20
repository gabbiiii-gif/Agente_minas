import { describe, expect, it } from "vitest";
import { expandir, type Sinonimos } from "../../src/catalogo/expandir.js";

const SINONIMOS: Sinonimos = new Map([
  ["RET", "RETENTOR"],
  ["DIANT", "DIANTEIRO"],
  ["TRAS", "TRASEIRO"],
  ["TRAZ", "TRASEIRO"],
  ["KIT RELACAO", "COROA TRANS"],
  ["COROA E PINHAO", "COROA TRANS"],
  ["TITAM", "TITAN"],
  ["PASTILHA", "PASTILHA FREIO"],
]);

describe("expandir", () => {
  it("expande abreviação do ERP", () => {
    expect(expandir("RET DIANT TITAN", SINONIMOS)).toBe(
      "RETENTOR DIANTEIRO TITAN",
    );
  });

  it("expande frase de mais de uma palavra", () => {
    expect(expandir("KIT RELACAO FAZER250", SINONIMOS)).toBe(
      "COROA TRANS FAZER250",
    );
  });

  it("prefere a frase mais longa quando há sobreposição", () => {
    expect(expandir("COROA E PINHAO XTZ125", SINONIMOS)).toBe(
      "COROA TRANS XTZ125",
    );
  });

  it("não entra em laço quando o canônico contém o termo", () => {
    expect(expandir("PASTILHA BIZ125", SINONIMOS)).toBe(
      "PASTILHA FREIO BIZ125",
    );
  });

  it("corrige erro de digitação do cliente", () => {
    expect(expandir("RETENTOR TITAM 160", SINONIMOS)).toBe(
      "RETENTOR TITAN 160",
    );
  });

  it("devolve o texto intacto quando nada casa", () => {
    expect(expandir("VELA NGK NX400", SINONIMOS)).toBe("VELA NGK NX400");
  });

  it("aceita mapa vazio", () => {
    expect(expandir("RET DIANT", new Map())).toBe("RET DIANT");
  });
});
