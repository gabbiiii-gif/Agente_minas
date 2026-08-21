import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Os testes de aceite chamam o modelo de verdade e custam dinheiro a cada
    // rodada. Ficam fora do `npm test` de propósito: rodam por
    // `npm run test:aceite`, antes de subir mudanca de prompt.
    exclude: ["node_modules/**", "tests/aceite/**"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    // Testes de integração compartilham o mesmo banco; em paralelo eles
    // pisariam uns nos dados dos outros (o importador zera estoque ausente).
    fileParallelism: false,
  },
});
