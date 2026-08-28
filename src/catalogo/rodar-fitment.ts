// Entrypoint de `npm run catalogo:fitment`.
//
// Três modos, do mais barato para o mais caro:
//
//   --recasar    refaz o casamento a partir da extração já guardada, sem API.
//                É o que rodar depois de mexer no seed de motos.
//   (sem flag)   extrai só as peças que ainda não passaram pela IA.
//   --tudo       reextrai o catálogo inteiro. Custa ~US$ 3,40 com Haiku e só
//                se justifica quando a instrução de extração mudou.
import { criarPool } from "../db/pool.js";
import { lerEnv } from "../config/env.js";
import { popularFitment, recasarFitment } from "./fitment.js";

const modo = process.argv[2];
const env = lerEnv();
const pool = criarPool(env.databaseUrl);

try {
  const r =
    modo === "--recasar"
      ? await recasarFitment(pool)
      : await popularFitment(pool, env.anthropicApiKey, modo !== "--tudo");
  console.log(
    `Produtos ${r.produtos} · vínculos criados ${r.vinculos} · sem casar ${r.semCasar}`,
  );
} finally {
  await pool.end();
}
