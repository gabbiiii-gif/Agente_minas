// Prepara o código compartilhado para a Edge Function.
//
// O Node exige extensão `.js` nos imports relativos, mesmo em TypeScript. O
// bundler do Supabase roda um Deno sem o contexto do `package.json`, então
// `./payload.js` não resolve para `payload.ts` e o deploy quebra com
// "Module not found".
//
// Em vez de mudar a convenção de todo o repositório — que tem 159 testes
// passando em cima dela — este script copia `src/` para dentro da pasta da
// função reescrevendo só os specifiers. `src/` continua sendo a única fonte;
// a cópia é artefato gerado e está no .gitignore.
//
// Roda sozinho antes do deploy: `npm run funcao:deploy`.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const ORIGEM = "src";
const DESTINO = join("supabase", "functions", "_shared");

/** Não vão para a função: são CLI de máquina de desenvolvedor. */
const FORA = ["cli.ts", "rodar-fitment.ts", "parear.ts", "estado.ts", "webhook.ts", "preparar-funcao.ts"];

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosTs(caminho);
    return nome.endsWith(".ts") && !FORA.includes(nome) ? [caminho] : [];
  });
}

/**
 * Troca `.js` por `.ts` só em import relativo.
 *
 * Specifier de pacote (`pg`, `@anthropic-ai/sdk`) fica como está — quem
 * resolve esses é o Deno, pelo `npm:`.
 */
function reescrever(codigo: string): string {
  return codigo.replace(/(from\s+["'])(\.[^"']*)\.js(["'])/g, "$1$2.ts$3");
}

rmSync(DESTINO, { recursive: true, force: true });

let n = 0;
for (const arquivo of arquivosTs(ORIGEM)) {
  const destino = join(DESTINO, relative(ORIGEM, arquivo));
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, reescrever(readFileSync(arquivo, "utf8")), "utf8");
  n += 1;
}

console.log(`${n} arquivos preparados em ${DESTINO}`);
