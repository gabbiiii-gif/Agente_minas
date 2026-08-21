import { defineConfig } from "vitest/config";

/**
 * Suíte de aceite: conversas de verdade contra o modelo e o catálogo real.
 *
 * Config separada porque estes testes custam dinheiro e levam minutos —
 * não podem rodar junto com `npm test` a cada salvamento.
 */
export default defineConfig({
  test: {
    include: ["tests/aceite/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    fileParallelism: false,
    // Um turno com ferramenta pode levar mais que os 5s padrão.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
