import { criarPool } from "../db/pool.js";
import { lerEnv } from "../config/env.js";
import { importarCatalogo } from "./importar.js";

const caminho = process.argv[2];
if (!caminho) {
  console.error("Uso: npm run catalogo:importar -- <caminho do RELATORIO ES.xlsx>");
  process.exit(1);
}

const pool = criarPool(lerEnv().databaseUrl);
try {
  const r = await importarCatalogo(pool, caminho);
  console.log(
    `Lidos ${r.lidos} · inseridos ${r.inseridos} · atualizados ${r.atualizados} · zerados ${r.zerados}`,
  );
} finally {
  await pool.end();
}
