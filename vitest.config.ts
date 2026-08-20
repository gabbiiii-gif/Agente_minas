import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    // Testes de integração compartilham o mesmo banco; em paralelo eles
    // pisariam uns nos dados dos outros (o importador zera estoque ausente).
    fileParallelism: false,
  },
});
