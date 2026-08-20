import { describe, expect, it } from "vitest";
import { normalizarTelefone } from "../../src/conversa/telefone.js";

/**
 * O telefone é a chave de identidade do contato, e ele chega em três formatos
 * diferentes: o jid do Evolution, o número que o dono digita no painel e o
 * que já está gravado no banco. Se os três não colapsarem na mesma string, o
 * mesmo cliente vira dois contatos e o histórico se parte no meio.
 */
describe("normalizarTelefone", () => {
  it("aceita o jid do evolution", () => {
    expect(normalizarTelefone("5593999998888@s.whatsapp.net")).toBe("5593999998888");
  });

  it("aceita número digitado com máscara", () => {
    expect(normalizarTelefone("(93) 99999-8888")).toBe("5593999998888");
  });

  it("completa o código do país quando falta", () => {
    expect(normalizarTelefone("93999998888")).toBe("5593999998888");
  });

  it("mantém o nono dígito de celular", () => {
    expect(normalizarTelefone("5593999998888")).toBe("5593999998888");
  });

  it("aceita fixo de oito dígitos", () => {
    expect(normalizarTelefone("559335151234")).toBe("559335151234");
  });

  it("recusa grupo", () => {
    expect(normalizarTelefone("12036304212345678@g.us")).toBeNull();
  });

  it("recusa status", () => {
    expect(normalizarTelefone("status@broadcast")).toBeNull();
  });

  it("recusa lixo", () => {
    expect(normalizarTelefone("abc")).toBeNull();
    expect(normalizarTelefone("")).toBeNull();
  });
});
