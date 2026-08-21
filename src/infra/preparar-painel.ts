// Copia a página do painel para onde a Vercel serve estático.
//
// A fonte é `src/painel/painel.html`, ao lado do servidor Fastify que a usa
// em desenvolvimento. `public/index.html` é artefato gerado — está no
// .gitignore e é refeito no build.
import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

mkdirSync("public", { recursive: true });
copyFileSync(join("src", "painel", "painel.html"), join("public", "index.html"));
console.log("public/index.html gerado a partir de src/painel/painel.html");
