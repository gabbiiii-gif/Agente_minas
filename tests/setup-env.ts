import { existsSync } from "node:fs";

// Vitest não lê `.env` sozinho. Sem isto, DATABASE_URL e TEST_DATABASE_URL
// ficam indefinidas e todo teste de integração é pulado em silêncio.
if (existsSync(".env")) process.loadEnvFile(".env");
