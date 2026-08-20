import { describe, expect, it } from "vitest";
import { montarPrompt, montarContexto } from "../../src/agente/prompt.js";

const LOJA = {
  horario: "Seg a Sex 8h-18h · Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
};

const prompt = montarPrompt(LOJA);

/**
 * Estes testes travam as três regras que o negócio não pode perder.
 *
 * Se um deles quebrar depois de você editar o prompt, a pergunta certa não é
 * "como faço o teste passar" — é "a regra ainda está no texto?". Prompt é
 * fácil demais de editar sem perceber o que se apagou junto.
 */
describe("montarPrompt — regras que o negócio não pode perder", () => {
  it("proíbe informar preço e manda transferir para o balcão", () => {
    expect(prompt).toContain("# REGRA NÚMERO 1 — PREÇO");
    expect(prompt).toMatch(/NÃO tem acesso a preço/);
    expect(prompt).toMatch(/Nunca informe, estime, sugira faixa/);
    expect(prompt).toMatch(/transferir_humano/);
  });

  it("proíbe dizer quantidade em estoque", () => {
    expect(prompt).toContain("# REGRA NÚMERO 2 — DISPONIBILIDADE, NUNCA QUANTIDADE");
    expect(prompt).toMatch(/não sabe quantas unidades existem/);
    expect(prompt).toMatch(/tenho vários/);
  });

  it("só deixa afirmar compatibilidade quando o balcão confirmou", () => {
    expect(prompt).toContain("# REGRA NÚMERO 3 — COMPATIBILIDADE");
    expect(prompt).toMatch(/vier "humano"/);
    expect(prompt).toMatch(/NUNCA deduza compatibilidade/);
  });

  it("repete preço e quantidade na lista final de proibições", () => {
    const proibicoes = prompt.slice(prompt.indexOf("# PROIBIÇÕES"));
    expect(proibicoes).toMatch(/Nunca fale preço/);
    expect(proibicoes).toMatch(/Nunca diga quantidade em estoque/);
  });
});

/**
 * O cache da API casa por PREFIXO: qualquer byte que mude de uma mensagem
 * para a outra faz o cache nunca acertar. Estes testes existem para não
 * deixar o relógio voltar para dentro do bloco fixo.
 */
describe("montarPrompt — prefixo estável para o cache", () => {
  it("devolve exatamente o mesmo texto em chamadas diferentes", () => {
    expect(montarPrompt(LOJA)).toBe(montarPrompt(LOJA));
  });

  it("não carrega data, hora nem quem é o cliente", () => {
    expect(prompt).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(prompt).not.toContain("Data/hora:");
    expect(prompt).not.toContain("Cliente:");
    expect(prompt).not.toContain("Moto cadastrada:");
  });

  it("carrega horário e endereço, que só mudam quando o dono edita", () => {
    expect(prompt).toContain(LOJA.horario);
    expect(prompt).toContain(LOJA.endereco);
  });
});

describe("montarContexto — a parte que muda a cada mensagem", () => {
  const agora = new Date("2026-08-20T18:30:00Z");

  it("traz data, cliente e moto", () => {
    const ctx = montarContexto({ agora, nome: "João", moto: "Honda CG 160" });
    expect(ctx).toContain("Data/hora:");
    expect(ctx).toContain("João");
    expect(ctx).toContain("Honda CG 160");
  });

  it("diz explicitamente quando não conhece o cliente nem a moto", () => {
    const ctx = montarContexto({ agora, nome: null, moto: null });
    expect(ctx).toContain("não identificado");
    expect(ctx).toContain("nenhuma");
  });

  it("muda quando o relógio anda — por isso fica fora do bloco cacheado", () => {
    const antes = montarContexto({ agora, nome: null, moto: null });
    const depois = montarContexto({
      agora: new Date("2026-08-21T18:30:00Z"),
      nome: null,
      moto: null,
    });
    expect(antes).not.toBe(depois);
  });
});
