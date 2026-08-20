// Entrypoint de `npm run catalogo:fitment`.
// Roda uma vez sobre o catálogo inteiro, offline, na máquina do desenvolvedor.
// Custo aproximado de US$ 2 com Haiku.
import { criarPool } from "../db/pool.js";
import { lerEnv } from "../config/env.js";
import { popularFitment } from "./fitment.js";

const env = lerEnv();
const pool = criarPool(env.databaseUrl);
try {
  const r = await popularFitment(pool, env.anthropicApiKey);
  console.log(
    `Produtos ${r.produtos} · vínculos criados ${r.vinculos} · sem casar ${r.semCasar}`,
  );
} finally {
  await pool.end();
}
