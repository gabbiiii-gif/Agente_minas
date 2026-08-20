import { describe, expect, it } from "vitest";
import { dividir } from "../../src/saida/dividir.js";

/**
 * Parede de texto denuncia bot e cansa quem lê no celular. A ordem de quebra
 * é parágrafo, depois frase — e a frase é a menor unidade que se preserva
 * inteira, mesmo passando um pouco do alvo. Só palavra gigante (link, código)
 * é cortada no meio.
 */
describe("dividir", () => {
  it("devolve uma parte só quando cabe", () => {
    expect(dividir("Tem sim. Retentor dianteiro Fan 160, código 4402.")).toHaveLength(1);
  });

  it("quebra em parágrafo antes de quebrar em frase", () => {
    const partes = dividir("Primeira ideia aqui.\n\nSegunda ideia aqui.", 30);
    expect(partes).toEqual(["Primeira ideia aqui.", "Segunda ideia aqui."]);
  });

  it("quebra em fim de frase quando o parágrafo não cabe", () => {
    const partes = dividir("Tenho essa peça. Confirma comigo antes de vir.", 25);
    expect(partes[0]).toBe("Tenho essa peça.");
    expect(partes[1]).toBe("Confirma comigo antes de vir.");
  });

  it("junta frases curtas até encher a parte", () => {
    const partes = dividir("Um. Dois. Três. Quatro.", 14);
    expect(partes).toEqual(["Um. Dois.", "Três. Quatro."]);
  });

  it("nunca devolve parte vazia", () => {
    expect(dividir("a.\n\n\n\nb.", 10).every((p) => p.trim() !== "")).toBe(true);
  });

  it("corta palavra gigante em vez de entrar em laço", () => {
    const partes = dividir("x".repeat(700), 280);
    expect(partes).toHaveLength(3);
    expect(partes[0]!.length).toBe(280);
  });

  it("devolve lista vazia para texto vazio", () => {
    expect(dividir("   ")).toEqual([]);
  });
});
