// tests/unit/env.test.ts
import { describe, expect, it } from "vitest";
import { lerEnv } from "../../src/config/env.js";

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
