// tests/unit/env.test.ts
import { describe, expect, it } from "vitest";
import { lerEnv, lerEnvGateway } from "../../src/config/env.js";

describe("lerEnv", () => {
  it("devolve as variáveis quando todas estão presentes", () => {
    const env = lerEnv({
      DATABASE_URL: "postgresql://localhost:5432/teste",
      ANTHROPIC_API_KEY: "sk-ant-teste",
    });
    expect(env.databaseUrl).toBe("postgresql://localhost:5432/teste");
    expect(env.anthropicApiKey).toBe("sk-ant-teste");
  });

  it("lança erro nomeando a variável que falta", () => {
    expect(() => lerEnv({ DATABASE_URL: "postgresql://x" })).toThrow(
      "Variável de ambiente ausente: ANTHROPIC_API_KEY",
    );
  });
});

const BASE = {
  DATABASE_URL: "postgresql://localhost:5432/teste",
  ANTHROPIC_API_KEY: "sk-ant-teste",
  EVOLUTION_URL: "http://localhost:8080",
  EVOLUTION_API_KEY: "chave-evo",
  WEBHOOK_SEGREDO: "segredo",
};

describe("lerEnvGateway", () => {
  it("lê o que o gateway precisa além do básico", () => {
    const env = lerEnvGateway({ ...BASE, PORTA: "3000", TELEFONE_DONO: "5593999999999" });
    expect(env.evolutionUrl).toBe("http://localhost:8080");
    expect(env.webhookSegredo).toBe("segredo");
    expect(env.porta).toBe(3000);
    expect(env.telefoneDono).toBe("5593999999999");
  });

  it("usa a instância do pareamento e a porta padrão quando não vêm", () => {
    const env = lerEnvGateway(BASE);
    expect(env.evolutionInstancia).toBe("minas");
    expect(env.porta).toBe(3000);
  });

  it("sobe sem telefone do dono — só não alerta ninguém", () => {
    expect(lerEnvGateway(BASE).telefoneDono).toBeNull();
  });

  it("recusa subir sem o segredo do webhook", () => {
    const { WEBHOOK_SEGREDO, ...semSegredo } = BASE;
    // Sem segredo o webhook ficaria aberto: melhor não subir.
    expect(() => lerEnvGateway(semSegredo)).toThrow(
      "Variável de ambiente ausente: WEBHOOK_SEGREDO",
    );
  });

  it("recusa porta inválida", () => {
    expect(() => lerEnvGateway({ ...BASE, PORTA: "abc" })).toThrow("PORTA inválida");
  });
});
