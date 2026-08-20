// tests/unit/normalizar.test.ts
import { describe, expect, it } from "vitest";
import { normalizar } from "../../src/catalogo/normalizar.js";

describe("normalizar", () => {
  it("põe em caixa alta e remove acento", () => {
    expect(normalizar("óleo hidráulico")).toBe("OLEO HIDRAULICO");
  });

  it("troca barra por espaço para separar modelos", () => {
    expect(normalizar("RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA")).toBe(
      "RETENTOR CUBO DIANT XR NX CBX TITAN ES HONDA",
    );
  });

  it("colapsa espaço duplicado", () => {
    expect(normalizar("FITA VEDA ROSCA 12/10  MAX PARTS")).toBe(
      "FITA VEDA ROSCA 12 10 MAX PARTS",
    );
  });

  it("preserva hífen de medida de pneu", () => {
    expect(normalizar("PNEU NXR DIANT. 90/90-19 BORRACHUDO REMOLD")).toBe(
      "PNEU NXR DIANT 90 90-19 BORRACHUDO REMOLD",
    );
  });

  it("normaliza a frase do cliente igual à do catálogo", () => {
    expect(normalizar("  retentor,  titam 160 ")).toBe("RETENTOR TITAM 160");
  });

  it("devolve string vazia para entrada vazia", () => {
    expect(normalizar("   ")).toBe("");
  });

  it("separa modelo de cilindrada para casar com o jeito do cliente", () => {
    // o ERP escreve grudado, o cliente escreve separado: os dois têm que
    // chegar na mesma forma, senão "fan 150" não acha "FAN150".
    expect(normalizar("CABO ACELERADOR FAN150 09/13 ESI")).toBe(
      "CABO ACELERADOR FAN 150 09 13 ESI",
    );
    expect(normalizar("cabo de acelerador fan 150")).toBe(
      "CABO DE ACELERADOR FAN 150",
    );
  });

  it("preserva medida de pneu, que é dígito com dígito", () => {
    expect(normalizar("PNEU 90/90-19 BORRACHUDO")).toBe("PNEU 90 90-19 BORRACHUDO");
  });
});
