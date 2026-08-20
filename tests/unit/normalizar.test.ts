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
});
