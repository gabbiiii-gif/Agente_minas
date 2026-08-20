# Fundação: catálogo e busca — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Importar o catálogo de 5.262 SKUs da Minas Auto Peças para o Postgres e entregar uma busca que encontre a peça do jeito que o cliente escreve, com recall medido.

**Architecture:** Um pacote Node/TypeScript com dois artefatos executáveis: um CLI de importação (`npm run catalogo:importar`) que lê o relatório do ERP e popula o banco, e um módulo de busca que consulta uma função SQL. A normalização de texto vive em TypeScript e é aplicada aos dois lados — catálogo e consulta — para que ambos convirjam na mesma forma. Nada de WhatsApp e nada de Claude conversacional neste plano; a única chamada ao modelo é a extração de compatibilidade em lote, offline.

**Tech Stack:** Node 20, TypeScript 5 (ESM), `pg` (node-postgres), `fflate`, `@anthropic-ai/sdk`, vitest.

## Global Constraints

- Node 20 ou superior. TypeScript 5, módulos ESM (`"type": "module"`).
- Acesso ao Postgres **apenas** por `pg` com `DATABASE_URL`. Não usar `supabase-js` neste plano — evita depender de "exposed schemas" do PostgREST e mantém tudo em SQL.
- Todo o schema fica em `agente`. Nada em `public`.
- **Preço não existe neste domínio.** Nenhuma coluna, nenhum campo, nenhuma string de preço em lugar nenhum. O ERP não exporta valor.
- Testes com vitest. Todo módulo puro tem teste unitário; nada de teste que dependa de rede num teste unitário.
- **Isolamento de banco nos testes.** Teste que escreve usa `TEST_DATABASE_URL` (Postgres local descartável, Task 5). Teste que só lê o catálogo real usa `DATABASE_URL`. Nunca escreva em produção a partir de teste: o importador zera o estoque de todo código ausente do arquivo, e um teste com planilha de 2 linhas zeraria os 5.232 produtos reais.
- `.env` nunca vai para o git. Só `.env.example`.
- Mensagens de commit em português, formato convencional (`feat:`, `fix:`, `test:`, `chore:`).
- Identificadores de código em português, seguindo o vocabulário do domínio (`produtos`, `buscar_peca`, `normalizar`).

## Desvios conscientes do spec

O spec (`docs/superpowers/specs/2026-08-19-agente-whatsapp-minas-auto-pecas-design.md`) define `agente.normalizar()` e `agente.expandir()` como funções SQL, mas na seção 9 lista as duas como alvo de teste unitário em vitest. Este plano resolve a contradição em favor do TypeScript: as duas são funções puras em `src/catalogo/`, aplicadas tanto no import quanto na consulta. A RPC `buscar_peca` passa a receber texto **já normalizado**.

O spec também cita Evolution API e Docker Compose na fase F1. Isso saiu deste plano: o Evolution só é necessário quando existir gateway de conversa, e entra no plano seguinte. Aqui, F1 é só Supabase e schema.

---

## Estrutura de arquivos

```
minas-agente/
├─ package.json
├─ tsconfig.json
├─ vitest.config.ts
├─ .env.example
├─ supabase/
│  ├─ migrations/
│  │  ├─ 0001_schema.sql          tabelas, índices, extensões
│  │  └─ 0002_buscar_peca.sql     função de busca
│  └─ seeds/
│     ├─ sinonimos.sql            abreviação do ERP e gíria do cliente
│     └─ motos.sql                frota de Altamira
├─ src/
│  ├─ config/env.ts               lê e valida variáveis de ambiente
│  ├─ db/
│  │  ├─ pool.ts                  Pool do pg
│  │  └─ migrar.ts                aplica migrations em ordem, registra em agente.migracoes
│  ├─ catalogo/
│  │  ├─ normalizar.ts            normalizar(texto)
│  │  ├─ expandir.ts              expandir(textoNorm, sinonimos)
│  │  ├─ planilha.ts              descompactar / validarCabecalho / parsearPlanilha
│  │  ├─ importar.ts              importarCatalogo(pool, caminho)
│  │  ├─ fitment.ts               extrairFitment(descricoes) via Haiku
│  │  └─ cli.ts                   entrypoint do npm run catalogo:importar
│  └─ busca/
│     └─ buscar.ts                buscarPeca(pool, texto, motoId)
└─ tests/
   ├─ unit/                       normalizar, expandir, planilha, fitment
   ├─ integracao/                 importar, buscar
   └─ busca/
      ├─ golden-set.json          consultas reais → códigos esperados
      └─ recall.test.ts           mede recall@3
```

Cada arquivo em `src/` tem uma responsabilidade. `normalizar.ts` e `expandir.ts` são puros e não conhecem banco. `planilha.ts` não conhece banco nem rede. `importar.ts` é o único que junta as peças.

---

### Task 1: Bootstrap do projeto

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/config/env.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `lerEnv(): Env` onde `interface Env { databaseUrl: string; anthropicApiKey: string }` — lança `Error` com mensagem em português quando falta variável.

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "minas-agente",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:migrar": "tsx src/db/migrar.ts",
    "catalogo:importar": "tsx src/catalogo/cli.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.65.0",
    "fflate": "^0.8.2",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Criar `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Criar `.env.example`**

```
# Produção: Supabase pelo shared pooler (IPv4). Projeto iajsbmnzpjuprasssvcl.
# A conexão direta db.PROJETO.supabase.co só atende IPv6 e falha em rede residencial.
DATABASE_URL=postgresql://postgres.iajsbmnzpjuprasssvcl:SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres

# Testes que escrevem: Postgres local descartável (docker compose -f docker-compose.teste.yml up -d)
TEST_DATABASE_URL=postgresql://postgres:teste@localhost:5433/postgres

# Chave da API Anthropic — usada só pela extração de fitment
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 5: Escrever o teste que falha**

```ts
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
```

- [ ] **Step 6: Rodar e confirmar a falha**

Run: `npm install && npx vitest run tests/unit/env.test.ts`
Expected: FAIL — não resolve `src/config/env.js`.

- [ ] **Step 7: Implementar `src/config/env.ts`**

```ts
export interface Env {
  databaseUrl: string;
  anthropicApiKey: string;
}

type Fonte = Record<string, string | undefined>;

function obrigatoria(fonte: Fonte, chave: string): string {
  const valor = fonte[chave];
  if (valor === undefined || valor.trim() === "") {
    throw new Error(`Variável de ambiente ausente: ${chave}`);
  }
  return valor;
}

export function lerEnv(fonte: Fonte = process.env): Env {
  return {
    databaseUrl: obrigatoria(fonte, "DATABASE_URL"),
    anthropicApiKey: obrigatoria(fonte, "ANTHROPIC_API_KEY"),
  };
}
```

- [ ] **Step 8: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/env.test.ts && npm run typecheck`
Expected: 2 testes passando, typecheck limpo.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/config/env.ts tests/unit/env.test.ts
git commit -m "chore: bootstrap do projeto com typescript, vitest e leitura de env"
```

---

### Task 2: Normalização de texto

Esta função roda nos dois lados da busca: na descrição vinda do ERP e na frase digitada pelo cliente. Se ela divergir entre os dois lados, a busca não acha nada.

**Files:**
- Create: `src/catalogo/normalizar.ts`
- Test: `tests/unit/normalizar.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `normalizar(texto: string): string` — caixa alta, sem acento, pontuação virando espaço, espaços colapsados. Preserva dígitos e hífen.

- [ ] **Step 1: Escrever o teste que falha**

Os casos vieram do arquivo real do ERP (`RELATORIO ES.xlsx`).

```ts
// tests/unit/normalizar.test.ts
import { describe, expect, it } from "vitest";
import { normalizar } from "../../src/catalogo/normalizar.js";

describe("normalizar", () => {
  it("põe em caixa alta e remove acento", () => {
    expect(normalizar("óleo hidráulico")).toBe("OLEO HIDRAULICO");
  });

  it("troca barra por espaço para separar modelos", () => {
    expect(normalizar("RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA")).toBe(
      "RETENTOR CUBO DIANT XR NX CBX TITAN ES HONDA",
    );
  });

  it("colapsa espaço duplicado", () => {
    expect(normalizar("FITA VEDA ROSCA 12/10  MAX PARTS")).toBe(
      "FITA VEDA ROSCA 12 10 MAX PARTS",
    );
  });

  it("preserva hífen de medida de pneu", () => {
    expect(normalizar("PNEU NXR DIANT. 90/90-19 BORRACHUDO REMOLD")).toBe(
      "PNEU NXR DIANT 90 90-19 BORRACHUDO REMOLD",
    );
  });

  it("normaliza a frase do cliente igual à do catálogo", () => {
    expect(normalizar("  retentor,  titam 160 ")).toBe("RETENTOR TITAM 160");
  });

  it("devolve string vazia para entrada vazia", () => {
    expect(normalizar("   ")).toBe("");
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/unit/normalizar.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/catalogo/normalizar.ts
const ACENTOS = /[̀-ͯ]/g;
const PONTUACAO = /[.,;:!?()[\]{}"'`\\/|+*_]/g;
const ESPACOS = /\s+/g;

/**
 * Forma canônica usada tanto na descrição do ERP quanto na frase do cliente.
 * Caixa alta, sem acento, pontuação vira espaço. Dígitos e hífen ficam.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(ACENTOS, "")
    .toUpperCase()
    .replace(PONTUACAO, " ")
    .replace(ESPACOS, " ")
    .trim();
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/normalizar.test.ts`
Expected: 6 testes passando.

- [ ] **Step 5: Commit**

```bash
git add src/catalogo/normalizar.ts tests/unit/normalizar.test.ts
git commit -m "feat(catalogo): normalizacao de texto para busca"
```

---

### Task 3: Expansão de sinônimos

O ERP abrevia (`RET DIANT`, `TRANS.`, `EMB.`) e o cliente usa outra palavra (`kit relação` onde o catálogo diz `COROA TRANS`). Esta função aproxima os dois vocabulários. Ela usa casamento de frase mais longa primeiro, e faz uma passagem só — nunca reprocessa a própria saída, então um sinônimo que expande para mais palavras não causa laço infinito.

**Files:**
- Create: `src/catalogo/expandir.ts`
- Test: `tests/unit/expandir.test.ts`

**Interfaces:**
- Consumes: `normalizar` da Task 2 (só nos testes, para preparar entrada)
- Produces: `type Sinonimos = ReadonlyMap<string, string>` e `expandir(textoNorm: string, sinonimos: Sinonimos): string`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/expandir.test.ts
import { describe, expect, it } from "vitest";
import { expandir, type Sinonimos } from "../../src/catalogo/expandir.js";

const SINONIMOS: Sinonimos = new Map([
  ["RET", "RETENTOR"],
  ["DIANT", "DIANTEIRO"],
  ["TRAS", "TRASEIRO"],
  ["TRAZ", "TRASEIRO"],
  ["KIT RELACAO", "COROA TRANS"],
  ["COROA E PINHAO", "COROA TRANS"],
  ["TITAM", "TITAN"],
  ["PASTILHA", "PASTILHA FREIO"],
]);

describe("expandir", () => {
  it("expande abreviação do ERP", () => {
    expect(expandir("RET DIANT TITAN", SINONIMOS)).toBe(
      "RETENTOR DIANTEIRO TITAN",
    );
  });

  it("expande frase de mais de uma palavra", () => {
    expect(expandir("KIT RELACAO FAZER250", SINONIMOS)).toBe(
      "COROA TRANS FAZER250",
    );
  });

  it("prefere a frase mais longa quando há sobreposição", () => {
    expect(expandir("COROA E PINHAO XTZ125", SINONIMOS)).toBe(
      "COROA TRANS XTZ125",
    );
  });

  it("não entra em laço quando o canônico contém o termo", () => {
    expect(expandir("PASTILHA BIZ125", SINONIMOS)).toBe(
      "PASTILHA FREIO BIZ125",
    );
  });

  it("corrige erro de digitação do cliente", () => {
    expect(expandir("RETENTOR TITAM 160", SINONIMOS)).toBe(
      "RETENTOR TITAN 160",
    );
  });

  it("devolve o texto intacto quando nada casa", () => {
    expect(expandir("VELA NGK NX400", SINONIMOS)).toBe("VELA NGK NX400");
  });

  it("aceita mapa vazio", () => {
    expect(expandir("RET DIANT", new Map())).toBe("RET DIANT");
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/unit/expandir.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/catalogo/expandir.ts
export type Sinonimos = ReadonlyMap<string, string>;

/**
 * Substitui termos por sua forma canônica em uma única passagem da esquerda
 * para a direita, sempre casando a frase mais longa possível. A saída não é
 * reprocessada, então um canônico que contém o próprio termo é seguro.
 *
 * @param textoNorm texto já passado por `normalizar`
 */
export function expandir(textoNorm: string, sinonimos: Sinonimos): string {
  if (sinonimos.size === 0) return textoNorm;

  const tokens = textoNorm.split(" ").filter((t) => t !== "");
  const maiorFrase = Math.max(
    ...[...sinonimos.keys()].map((chave) => chave.split(" ").length),
  );

  const saida: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    let casou = false;
    const limite = Math.min(maiorFrase, tokens.length - i);

    for (let n = limite; n >= 1; n--) {
      const frase = tokens.slice(i, i + n).join(" ");
      const canonico = sinonimos.get(frase);
      if (canonico !== undefined) {
        saida.push(canonico);
        i += n;
        casou = true;
        break;
      }
    }

    if (!casou) {
      saida.push(tokens[i]!);
      i += 1;
    }
  }

  return saida.join(" ");
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/expandir.test.ts`
Expected: 7 testes passando.

- [ ] **Step 5: Commit**

```bash
git add src/catalogo/expandir.ts tests/unit/expandir.test.ts
git commit -m "feat(catalogo): expansao de sinonimos com casamento de frase mais longa"
```

---

### Task 4: Leitor da planilha do ERP

O relatório sai como `.xlsx`, que é um zip de XML. O módulo é dividido em duas partes: `descompactar` toca no binário, `parsearPlanilha` é puro e recebe XML como string — assim o teste unitário usa um XML pequeno escrito à mão, sem precisar de arquivo binário com dado da loja no repositório.

Layout real observado no arquivo `RELATORIO ES.xlsx`: cabeçalho na linha 4, dados a partir da linha 6, coluna `A` = Código, `D` = Produto, `J` = Unid., `Q` = Estoque.

**Files:**
- Create: `src/catalogo/planilha.ts`
- Test: `tests/unit/planilha.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `interface LinhaEstoque { codigo: string; descricao: string; unidade: string; estoque: number }`
  - `descompactar(buffer: Uint8Array): { sharedStrings: string; sheet: string }`
  - `validarCabecalho(sharedStringsXml: string, sheetXml: string): void` — lança se o layout mudou
  - `parsearPlanilha(sharedStringsXml: string, sheetXml: string): LinhaEstoque[]`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/planilha.test.ts
import { describe, expect, it } from "vitest";
import { parsearPlanilha, validarCabecalho } from "../../src/catalogo/planilha.js";

const SHARED = `<?xml version="1.0"?><x:sst xmlns:x="s">
<x:si><x:t>Código</x:t></x:si>
<x:si><x:t>Produto</x:t></x:si>
<x:si><x:t>Unid.</x:t></x:si>
<x:si><x:t>Estoque</x:t></x:si>
<x:si><x:t>ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA</x:t></x:si>
<x:si><x:t>UND</x:t></x:si>
<x:si><x:t>PROTETOR BRACO CAMBIO CORES ROSENDO</x:t></x:si>
<x:si><x:t>PAR</x:t></x:si>
</x:sst>`;

const SHEET = `<?xml version="1.0"?><x:worksheet xmlns:x="s"><x:sheetData>
<x:row r="4"><x:c r="A4" t="s"><x:v>0</x:v></x:c><x:c r="D4" t="s"><x:v>1</x:v></x:c><x:c r="J4" t="s"><x:v>2</x:v></x:c><x:c r="Q4" t="s"><x:v>3</x:v></x:c></x:row>
<x:row r="6"><x:c r="A6"><x:v>1</x:v></x:c><x:c r="D6" t="s"><x:v>4</x:v></x:c><x:c r="J6" t="s"><x:v>5</x:v></x:c><x:c r="Q6"><x:v>1</x:v></x:c></x:row>
<x:row r="7"><x:c r="A7"><x:v>27</x:v></x:c><x:c r="D7" t="s"><x:v>6</x:v></x:c><x:c r="J7" t="s"><x:v>7</x:v></x:c><x:c r="Q7"><x:v>2</x:v></x:c></x:row>
<x:row r="8"><x:c r="A8"><x:v>99</x:v></x:c><x:c r="J8" t="s"><x:v>5</x:v></x:c><x:c r="Q8"><x:v>4</x:v></x:c></x:row>
</x:sheetData></x:worksheet>`;

describe("parsearPlanilha", () => {
  it("lê código, descrição, unidade e estoque", () => {
    const linhas = parsearPlanilha(SHARED, SHEET);
    expect(linhas).toEqual([
      {
        codigo: "1",
        descricao: "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA",
        unidade: "UND",
        estoque: 1,
      },
      {
        codigo: "27",
        descricao: "PROTETOR BRACO CAMBIO CORES ROSENDO",
        unidade: "PAR",
        estoque: 2,
      },
    ]);
  });

  it("descarta linha sem descrição", () => {
    const linhas = parsearPlanilha(SHARED, SHEET);
    expect(linhas.find((l) => l.codigo === "99")).toBeUndefined();
  });
});

describe("validarCabecalho", () => {
  it("aceita o layout esperado", () => {
    expect(() => validarCabecalho(SHARED, SHEET)).not.toThrow();
  });

  it("recusa quando a coluna do produto mudou de lugar", () => {
    const trocado = SHEET.replace('r="D4"', 'r="E4"');
    expect(() => validarCabecalho(SHARED, trocado)).toThrow(
      "Layout do relatório mudou",
    );
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/unit/planilha.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/catalogo/planilha.ts
import { unzipSync, strFromU8 } from "fflate";

export interface LinhaEstoque {
  codigo: string;
  descricao: string;
  unidade: string;
  estoque: number;
}

/** Colunas do relatório "Estoque - Normal" do ERP. */
const COLUNAS = {
  codigo: "A",
  descricao: "D",
  unidade: "J",
  estoque: "Q",
} as const;

const LINHA_CABECALHO = "4";

const RE_ITEM = /<x:si>(.*?)<\/x:si>/gs;
const RE_TEXTO = /<x:t[^>]*>(.*?)<\/x:t>/gs;
const RE_LINHA = /<x:row[^>]*r="(\d+)"[^>]*>(.*?)<\/x:row>/gs;
const RE_CELULA = /<x:c r="([A-Z]+)\d+"([^>]*)>(?:<x:v>(.*?)<\/x:v>)?/gs;

function lerSharedStrings(xml: string): string[] {
  return [...xml.matchAll(RE_ITEM)].map((item) =>
    [...item[1]!.matchAll(RE_TEXTO)].map((t) => t[1]!).join(""),
  );
}

function lerLinhas(
  sheetXml: string,
  strs: string[],
): Array<{ numero: string; celulas: Record<string, string> }> {
  return [...sheetXml.matchAll(RE_LINHA)].map((linha) => {
    const celulas: Record<string, string> = {};
    for (const c of linha[2]!.matchAll(RE_CELULA)) {
      const coluna = c[1]!;
      const bruto = c[3];
      if (bruto === undefined) continue;
      const ehTexto = /t="s"/.test(c[2]!);
      celulas[coluna] = ehTexto ? (strs[Number(bruto)] ?? "") : bruto;
    }
    return { numero: linha[1]!, celulas };
  });
}

export function descompactar(buffer: Uint8Array): {
  sharedStrings: string;
  sheet: string;
} {
  const arquivos = unzipSync(buffer);
  const nomeSheet = Object.keys(arquivos).find((n) =>
    /^xl\/worksheets\/.*\.xml$/.test(n),
  );
  const nomeShared = "xl/sharedStrings.xml";
  if (!nomeSheet || !arquivos[nomeShared]) {
    throw new Error("Arquivo não parece um relatório do ERP: falta planilha ou sharedStrings");
  }
  return {
    sharedStrings: strFromU8(arquivos[nomeShared]!),
    sheet: strFromU8(arquivos[nomeSheet]!),
  };
}

/** Falha alto e cedo se o ERP mudar a ordem das colunas. */
export function validarCabecalho(sharedStringsXml: string, sheetXml: string): void {
  const strs = lerSharedStrings(sharedStringsXml);
  const cabecalho = lerLinhas(sheetXml, strs).find(
    (l) => l.numero === LINHA_CABECALHO,
  );
  if (!cabecalho) {
    throw new Error(`Layout do relatório mudou: linha ${LINHA_CABECALHO} não encontrada`);
  }
  const esperado: Array<[string, string]> = [
    [COLUNAS.codigo, "Código"],
    [COLUNAS.descricao, "Produto"],
    [COLUNAS.unidade, "Unid."],
    [COLUNAS.estoque, "Estoque"],
  ];
  for (const [coluna, titulo] of esperado) {
    if (cabecalho.celulas[coluna] !== titulo) {
      throw new Error(
        `Layout do relatório mudou: esperava "${titulo}" na coluna ${coluna}, veio "${cabecalho.celulas[coluna] ?? ""}"`,
      );
    }
  }
}

export function parsearPlanilha(
  sharedStringsXml: string,
  sheetXml: string,
): LinhaEstoque[] {
  const strs = lerSharedStrings(sharedStringsXml);
  const linhas: LinhaEstoque[] = [];

  for (const { numero, celulas } of lerLinhas(sheetXml, strs)) {
    if (numero === LINHA_CABECALHO) continue;
    const codigo = (celulas[COLUNAS.codigo] ?? "").trim();
    const descricao = (celulas[COLUNAS.descricao] ?? "").trim();
    if (!/^\d+$/.test(codigo) || descricao === "") continue;

    linhas.push({
      codigo,
      descricao,
      unidade: (celulas[COLUNAS.unidade] ?? "UND").trim(),
      estoque: Number.parseInt(celulas[COLUNAS.estoque] ?? "0", 10) || 0,
    });
  }

  return linhas;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/planilha.test.ts && npm run typecheck`
Expected: 4 testes passando.

- [ ] **Step 5: Conferir contra o arquivo real**

Run:
```bash
node --experimental-strip-types -e "
import { readFileSync } from 'node:fs';
import { descompactar, validarCabecalho, parsearPlanilha } from './src/catalogo/planilha.ts';
const buf = readFileSync(process.argv[1]);
const { sharedStrings, sheet } = descompactar(buf);
validarCabecalho(sharedStrings, sheet);
const linhas = parsearPlanilha(sharedStrings, sheet);
console.log('linhas:', linhas.length);
console.log(linhas.slice(0, 3));
" "$HOME/Downloads/RELATORIO ES.xlsx"
```
Expected: `linhas: 5232` e as três primeiras batendo com códigos 1, 6 e 11.

Se o número vier diferente, **pare e investigue** antes de seguir — o parser é a base de todo o resto.

- [ ] **Step 6: Commit**

```bash
git add src/catalogo/planilha.ts tests/unit/planilha.test.ts
git commit -m "feat(catalogo): leitor do relatorio de estoque do erp"
```

---

### Task 5: Conexão e runner de migrações

**Files:**
- Create: `src/db/pool.ts`, `src/db/migrar.ts`, `docker-compose.teste.yml`
- Test: `tests/integracao/migrar.test.ts`

**Interfaces:**
- Consumes: `lerEnv` da Task 1
- Produces:
  - `criarPool(databaseUrl: string): Pool`
  - `aplicarMigracoes(pool: Pool, diretorio: string): Promise<string[]>` — devolve os nomes aplicados nesta execução, em ordem; já aplicadas são puladas.

- [ ] **Step 1: Subir o Postgres de teste**

Todo teste que escreve roda aqui, nunca no Supabase de produção. Porta 5433 para não brigar com um Postgres local que já exista.

```yaml
# docker-compose.teste.yml
services:
  postgres-teste:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: teste
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
```

Run: `docker compose -f docker-compose.teste.yml up -d`
Expected: container no ar. Confirme com `docker compose -f docker-compose.teste.yml ps`.

O `tmpfs` faz o banco viver em memória: cada `down` apaga tudo, que é exatamente o que se quer de banco de teste.

- [ ] **Step 2: Escrever o teste que falha**

O teste pula sozinho se `TEST_DATABASE_URL` não estiver no ambiente, para não quebrar `npm test` de quem só mexe em código puro.

```ts
// tests/integracao/migrar.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("aplicarMigracoes", () => {
  let pool: Pool;
  let dir: string;

  beforeAll(async () => {
    pool = criarPool(url!);
    dir = mkdtempSync(join(tmpdir(), "migr-"));
    writeFileSync(join(dir, "9001_teste.sql"), "create table if not exists teste_migracao (id int);");
    await pool.query("drop table if exists teste_migracao");
    await pool.query("delete from agente.migracoes where nome = '9001_teste.sql'").catch(() => {});
  });

  afterAll(async () => {
    await pool.query("drop table if exists teste_migracao");
    await pool.query("delete from agente.migracoes where nome = '9001_teste.sql'");
    await pool.end();
  });

  it("aplica migração nova e registra", async () => {
    const aplicadas = await aplicarMigracoes(pool, dir);
    expect(aplicadas).toContain("9001_teste.sql");
  });

  it("não reaplica migração já registrada", async () => {
    const aplicadas = await aplicarMigracoes(pool, dir);
    expect(aplicadas).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar e confirmar a falha**

Run: `npx vitest run tests/integracao/migrar.test.ts`
Expected: FAIL — módulos não existem. Se vier SKIP, `TEST_DATABASE_URL` não está no ambiente: preencha `.env` e confirme que o container do Step 1 está no ar.

- [ ] **Step 4: Implementar o pool**

```ts
// src/db/pool.ts
import pg from "pg";

/**
 * O host do pooler é `pooler.supabase.com`, não `supabase.co` — por isso a
 * checagem é pelo prefixo `supabase.`, que cobre os dois. Errar isso derruba
 * a conexão com "no encryption" só em produção.
 */
export function criarPool(databaseUrl: string): pg.Pool {
  const ehSupabase = databaseUrl.includes("supabase.");
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    ssl: ehSupabase ? { rejectUnauthorized: false } : undefined,
  });
}
```

- [ ] **Step 5: Implementar o runner**

```ts
// src/db/migrar.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { criarPool } from "./pool.js";
import { lerEnv } from "../config/env.js";

const CONTROLE = `
  create schema if not exists agente;
  create table if not exists agente.migracoes (
    nome        text primary key,
    aplicada_em timestamptz not null default now()
  );
`;

export async function aplicarMigracoes(
  pool: Pool,
  diretorio: string,
): Promise<string[]> {
  await pool.query(CONTROLE);

  const { rows } = await pool.query<{ nome: string }>(
    "select nome from agente.migracoes",
  );
  const jaAplicadas = new Set(rows.map((r) => r.nome));

  const arquivos = readdirSync(diretorio)
    .filter((n) => n.endsWith(".sql"))
    .sort();

  const aplicadas: string[] = [];

  for (const nome of arquivos) {
    if (jaAplicadas.has(nome)) continue;
    const sql = readFileSync(join(diretorio, nome), "utf8");
    const cliente = await pool.connect();
    try {
      await cliente.query("begin");
      await cliente.query(sql);
      await cliente.query("insert into agente.migracoes (nome) values ($1)", [nome]);
      await cliente.query("commit");
      aplicadas.push(nome);
    } catch (erro) {
      await cliente.query("rollback");
      throw new Error(`Migração ${nome} falhou: ${(erro as Error).message}`);
    } finally {
      cliente.release();
    }
  }

  return aplicadas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = lerEnv();
  const pool = criarPool(env.databaseUrl);
  const aplicadas = await aplicarMigracoes(pool, "supabase/migrations");
  console.log(
    aplicadas.length > 0
      ? `Aplicadas: ${aplicadas.join(", ")}`
      : "Nada novo para aplicar.",
  );
  await pool.end();
}
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `npx vitest run tests/integracao/migrar.test.ts`
Expected: 2 testes passando.

- [ ] **Step 7: Commit**

```bash
git add src/db/pool.ts src/db/migrar.ts docker-compose.teste.yml tests/integracao/migrar.test.ts
git commit -m "feat(db): pool do postgres, runner de migracoes e banco de teste local"
```

---

### Task 6: Migração do schema

**Files:**
- Create: `supabase/migrations/0001_schema.sql`
- Test: `tests/integracao/schema.test.ts`

**Interfaces:**
- Consumes: `aplicarMigracoes` da Task 5
- Produces: tabelas `agente.produtos`, `agente.motos`, `agente.produto_moto`, `agente.sinonimos`, `agente.contatos`, `agente.conversas`, `agente.mensagens`, `agente.demanda_nao_atendida`, `agente.config`, `agente.saidas_pendentes`

As tabelas de conversa (`contatos`, `conversas`, `mensagens`, `demanda_nao_atendida`, `config`, `saidas_pendentes`) são criadas agora, ainda que só sejam usadas no plano seguinte: uma migração só, aplicada uma vez, evita mexer no banco de produção duas vezes.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/integracao/schema.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("schema agente", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("cria todas as tabelas previstas", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'agente'",
    );
    const nomes = rows.map((r) => r.table_name);
    for (const esperada of [
      "produtos", "motos", "produto_moto", "sinonimos",
      "contatos", "conversas", "mensagens", "demanda_nao_atendida",
      "config", "saidas_pendentes",
    ]) {
      expect(nomes).toContain(esperada);
    }
  });

  it("não tem nenhuma coluna de preço em lugar nenhum", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns
       where table_schema = 'agente'
         and (column_name ilike '%preco%' or column_name ilike '%valor%')`,
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("habilita pg_trgm e unaccent", async () => {
    const { rows } = await pool.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('pg_trgm','unaccent')",
    );
    expect(rows.map((r) => r.extname).sort()).toEqual(["pg_trgm", "unaccent"]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/integracao/schema.test.ts`
Expected: FAIL — tabelas não existem.

- [ ] **Step 3: Escrever a migração**

```sql
-- supabase/migrations/0001_schema.sql
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create schema if not exists agente;

-- ---------- catálogo ----------
create table if not exists agente.produtos (
  id             uuid primary key default gen_random_uuid(),
  codigo         text unique not null,
  descricao      text not null,
  descricao_norm text not null,
  unidade        text,
  estoque        int  not null default 0,
  ativo          boolean not null default true,
  atualizado_em  timestamptz not null default now()
);

create table if not exists agente.motos (
  id         uuid primary key default gen_random_uuid(),
  marca      text not null,
  modelo     text not null,
  cilindrada int,
  ano_ini    int,
  ano_fim    int,
  apelidos   text[] not null default '{}',
  unique (marca, modelo, cilindrada, ano_ini)
);

create table if not exists agente.produto_moto (
  produto_id uuid not null references agente.produtos(id) on delete cascade,
  moto_id    uuid not null references agente.motos(id)    on delete cascade,
  origem     text not null check (origem in ('auto','humano')),
  confianca  real,
  primary key (produto_id, moto_id)
);

create table if not exists agente.sinonimos (
  termo    text primary key,
  canonico text not null
);

-- ---------- conversa (usado no plano seguinte) ----------
create table if not exists agente.contatos (
  id             uuid primary key default gen_random_uuid(),
  telefone       text unique not null,
  nome           text,
  moto_id        uuid references agente.motos(id),
  bairro         text,
  opt_in         boolean not null default true,
  silenciado_ate timestamptz,
  criado_em      timestamptz not null default now()
);

create table if not exists agente.conversas (
  id            uuid primary key default gen_random_uuid(),
  contato_id    uuid not null references agente.contatos(id) on delete cascade,
  status        text not null default 'ativa'
                check (status in ('ativa','aguardando_humano','encerrada')),
  intencao      text,
  desfecho      text,
  resumo        text,
  iniciada_em   timestamptz not null default now(),
  ultima_msg_em timestamptz not null default now()
);

create table if not exists agente.mensagens (
  id          bigserial primary key,
  conversa_id uuid not null references agente.conversas(id) on delete cascade,
  papel       text not null check (papel in ('cliente','agente','humano','sistema')),
  conteudo    text,
  tipo_midia  text not null default 'texto'
              check (tipo_midia in ('texto','imagem','audio')),
  midia_url   text,
  msg_ext_id  text unique,
  tokens_in   int,
  tokens_out  int,
  modelo      text,
  criado_em   timestamptz not null default now()
);

create table if not exists agente.demanda_nao_atendida (
  id          bigserial primary key,
  conversa_id uuid references agente.conversas(id) on delete set null,
  texto_bruto text not null,
  peca_norm   text,
  moto_id     uuid references agente.motos(id),
  motivo      text not null
              check (motivo in ('sem_estoque','nao_cadastrado','nao_trabalhamos')),
  criado_em   timestamptz not null default now()
);

create table if not exists agente.config (
  chave text primary key,
  valor jsonb not null
);

create table if not exists agente.saidas_pendentes (
  id         bigserial primary key,
  telefone   text not null,
  conteudo   text not null,
  tentativas int not null default 0,
  erro       text,
  criado_em  timestamptz not null default now()
);

-- ---------- índices ----------
create index if not exists produtos_descricao_norm_trgm
  on agente.produtos using gin (descricao_norm gin_trgm_ops);
create index if not exists produtos_codigo on agente.produtos (codigo);
create index if not exists motos_apelidos on agente.motos using gin (apelidos);
create index if not exists mensagens_conversa on agente.mensagens (conversa_id, criado_em desc);
create index if not exists demanda_recente on agente.demanda_nao_atendida (criado_em desc);

-- ---------- RLS: nada exposto ----------
-- O serviço acessa por conexão direta com o usuário postgres, não por PostgREST.
-- Ligar RLS sem policy garante que qualquer acesso via anon/authenticated seja negado.
alter table agente.produtos             enable row level security;
alter table agente.motos                enable row level security;
alter table agente.produto_moto         enable row level security;
alter table agente.sinonimos            enable row level security;
alter table agente.contatos             enable row level security;
alter table agente.conversas            enable row level security;
alter table agente.mensagens            enable row level security;
alter table agente.demanda_nao_atendida enable row level security;
alter table agente.config               enable row level security;
alter table agente.saidas_pendentes     enable row level security;
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm run db:migrar && npx vitest run tests/integracao/schema.test.ts`
Expected: `Aplicadas: 0001_schema.sql` e 3 testes passando.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_schema.sql tests/integracao/schema.test.ts
git commit -m "feat(db): schema agente com catalogo, conversa e demanda"
```

---

### Task 7: Seeds de sinônimos e motos

**Files:**
- Create: `supabase/seeds/sinonimos.sql`, `supabase/seeds/motos.sql`
- Modify: `package.json` (script `db:seed`)
- Create: `src/db/semear.ts`
- Test: `tests/integracao/seeds.test.ts`

**Interfaces:**
- Consumes: `criarPool` (Task 5), schema (Task 6)
- Produces: `carregarSinonimos(pool: Pool): Promise<Sinonimos>` — usado pelo importador e pela busca.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/integracao/seeds.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { carregarSinonimos, semear } from "../../src/db/semear.js";
import { expandir } from "../../src/catalogo/expandir.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("seeds", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = criarPool(url!);
    await semear(pool);
  });
  afterAll(async () => { await pool.end(); });

  it("carrega sinônimos do banco", async () => {
    const sinonimos = await carregarSinonimos(pool);
    expect(sinonimos.get("RET")).toBe("RETENTOR");
    expect(sinonimos.get("KIT RELACAO")).toBe("COROA TRANS");
  });

  it("expande a gíria do cliente com os sinônimos reais", async () => {
    const sinonimos = await carregarSinonimos(pool);
    expect(expandir("KIT RELACAO FAZER250", sinonimos)).toBe("COROA TRANS FAZER250");
    expect(expandir("RET DIANT TITAM", sinonimos)).toBe("RETENTOR DIANTEIRO TITAN");
  });

  it("acha moto por apelido", async () => {
    const { rows } = await pool.query<{ modelo: string }>(
      "select modelo from agente.motos where $1 = any(apelidos)",
      ["titam"],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.modelo).toBe("titan");
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/integracao/seeds.test.ts`
Expected: FAIL — `carregarSinonimos` não existe e as tabelas estão vazias.

- [ ] **Step 3: Escrever o seed de sinônimos**

Os termos abreviados saíram do arquivo real do ERP. Os termos de cliente saíram do vocabulário de balcão.

```sql
-- supabase/seeds/sinonimos.sql
insert into agente.sinonimos (termo, canonico) values
  -- abreviações do ERP
  ('RET',            'RETENTOR'),
  ('DIANT',          'DIANTEIRO'),
  ('TRAS',           'TRASEIRO'),
  ('TRAZ',           'TRASEIRO'),
  ('EMB',            'EMBREAGEM'),
  ('TRANS',          'TRANSMISSAO'),
  ('VIRAB',          'VIRABREQUIM'),
  ('CROM',           'CROMADO'),
  ('ESQ',            'ESQUERDO'),
  ('DIR',            'DIREITO'),
  ('LAT',            'LATERAL'),
  ('PRIM',           'PRIMARIA'),
  ('EXT',            'EXTERNA'),
  ('COMB',           'COMBUSTIVEL'),
  ('JG',             'JOGO'),
  ('MANG',           'MANGUEIRA'),
  ('MOD',            'MODELO'),
  ('ORIG',           'ORIGINAL'),
  ('PTO',            'PRETO'),
  ('COMP',           'COMPETICAO'),
  ('COMPET',         'COMPETICAO'),
  -- vocabulário do cliente
  ('KIT RELACAO',    'COROA TRANS'),
  ('RELACAO',        'COROA TRANS'),
  ('COROA E PINHAO', 'COROA TRANS'),
  ('TITAM',          'TITAN'),
  ('BIZZ',           'BIZ'),
  ('FAM',            'FAN'),
  ('BROSS',          'BROS'),
  ('FASER',          'FAZER'),
  ('PASTILHA',       'PASTILHA FREIO'),
  ('LONA',           'LONA FREIO'),
  ('VELA DE IGNICAO','VELA'),
  ('CAMARA DE AR',   'CAMARA'),
  ('OLHO DE GATO',   'OLHO GATO'),
  ('PISCA',          'PISCA'),
  ('BENGALA',        'BENGALA'),
  ('COXIM',          'COXIM')
on conflict (termo) do update set canonico = excluded.canonico;
```

- [ ] **Step 4: Escrever o seed de motos**

Frota mais comum em Altamira, extraída dos modelos que aparecem nas descrições do próprio catálogo.

```sql
-- supabase/seeds/motos.sql
insert into agente.motos (marca, modelo, cilindrada, ano_ini, ano_fim, apelidos) values
  ('honda','titan',125,2000,2015,'{"titam","titan 125","cg125","cg 125"}'),
  ('honda','titan',150,2004,2015,'{"titam 150","titan 150","cg150","cg 150"}'),
  ('honda','titan',160,2016,2026,'{"titam 160","titan 160","cg160","cg 160"}'),
  ('honda','fan',125,2005,2015,'{"fan 125","cg fan 125"}'),
  ('honda','fan',150,2009,2015,'{"fan 150","cg fan 150"}'),
  ('honda','fan',160,2016,2026,'{"fan 160","cg fan 160"}'),
  ('honda','biz',100,1998,2012,'{"biz 100","bizz 100"}'),
  ('honda','biz',110,2015,2026,'{"biz 110","biz110i","biz 110i"}'),
  ('honda','biz',125,2005,2026,'{"biz 125","bizz 125"}'),
  ('honda','pop',100,2007,2015,'{"pop 100"}'),
  ('honda','pop',110,2016,2026,'{"pop 110","pop110i"}'),
  ('honda','bros',125,2003,2014,'{"nxr125","nxr 125","bros 125"}'),
  ('honda','bros',150,2003,2015,'{"nxr150","nxr 150","bros 150"}'),
  ('honda','bros',160,2015,2026,'{"nxr160","nxr 160","bros 160"}'),
  ('honda','xre',190,2016,2026,'{"xre 190"}'),
  ('honda','xre',300,2010,2026,'{"xre 300","xre300"}'),
  ('honda','xr',250,2006,2015,'{"tornado","xr250","xr 250"}'),
  ('honda','cb',300,2009,2026,'{"cb300","cb 300","twister"}'),
  ('honda','falcon',400,1999,2012,'{"nx400","nx 400","falcon"}'),
  ('honda','cbx',250,2001,2009,'{"cbx250","twister 250"}'),
  ('honda','xlr',125,1997,2002,'{"xlr125","xlr 125"}'),
  ('yamaha','ybr',125,2000,2016,'{"ybr125","ybr 125"}'),
  ('yamaha','factor',125,2009,2026,'{"factor 125","ybr factor 125"}'),
  ('yamaha','factor',150,2016,2026,'{"factor 150"}'),
  ('yamaha','fazer',250,2005,2026,'{"fazer 250","faser 250"}'),
  ('yamaha','crypton',105,1998,2008,'{"crypton","crypton 105"}'),
  ('yamaha','neo',115,2007,2016,'{"neo 115","neo"}'),
  ('yamaha','xtz',125,2003,2026,'{"xtz125","xtz 125"}'),
  ('yamaha','xtz',150,2016,2026,'{"xtz150","crosser","xtz 150"}'),
  ('yamaha','xtz',250,2006,2026,'{"xtz250","lander","xtz 250"}'),
  ('suzuki','yes',125,2006,2015,'{"yes 125","yes125"}'),
  ('suzuki','intruder',125,2004,2018,'{"intruder 125"}'),
  ('suzuki','burgman',125,2006,2026,'{"burgman 125","burgman"}')
on conflict (marca, modelo, cilindrada, ano_ini) do nothing;
```

- [ ] **Step 5: Implementar `semear.ts` e o carregador de sinônimos**

```ts
// src/db/semear.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Sinonimos } from "../catalogo/expandir.js";
import { criarPool } from "./pool.js";
import { lerEnv } from "../config/env.js";

export async function semear(pool: Pool, diretorio = "supabase/seeds"): Promise<void> {
  for (const nome of readdirSync(diretorio).filter((n) => n.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(diretorio, nome), "utf8"));
  }
}

export async function carregarSinonimos(pool: Pool): Promise<Sinonimos> {
  const { rows } = await pool.query<{ termo: string; canonico: string }>(
    "select termo, canonico from agente.sinonimos",
  );
  return new Map(rows.map((r) => [r.termo, r.canonico]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = criarPool(lerEnv().databaseUrl);
  await semear(pool);
  console.log("Seeds aplicados.");
  await pool.end();
}
```

- [ ] **Step 6: Adicionar o script ao `package.json`**

Em `"scripts"`, acrescente:

```json
"db:seed": "tsx src/db/semear.ts"
```

- [ ] **Step 7: Rodar e confirmar que passa**

Run: `npm run db:seed && npx vitest run tests/integracao/seeds.test.ts`
Expected: `Seeds aplicados.` e 3 testes passando.

- [ ] **Step 8: Commit**

```bash
git add supabase/seeds src/db/semear.ts tests/integracao/seeds.test.ts package.json
git commit -m "feat(db): seeds de sinonimos e da frota de altamira"
```

---

### Task 8: Importador de catálogo

**Files:**
- Create: `src/catalogo/importar.ts`, `src/catalogo/cli.ts`
- Test: `tests/integracao/importar.test.ts`

**Interfaces:**
- Consumes: `parsearPlanilha`, `descompactar`, `validarCabecalho` (Task 4), `normalizar` (Task 2), `expandir` (Task 3), `carregarSinonimos` (Task 7)
- Produces:
  - `interface ResultadoImport { lidos: number; inseridos: number; atualizados: number; zerados: number }`
  - `importarCatalogo(pool: Pool, caminho: string): Promise<ResultadoImport>`

Regra de ausência: código que estava no banco e não veio no arquivo tem `estoque` zerado, mas continua `ativo`. Ausência no relatório significa "sem estoque", não "produto morto".

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/integracao/importar.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import { semear } from "../../src/db/semear.js";
import { importarCatalogo } from "../../src/catalogo/importar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

function planilhaFalsa(itens: Array<[string, string, string, number]>): Uint8Array {
  const strs = ["Código", "Produto", "Unid.", "Estoque"];
  const idx = (s: string) => {
    const i = strs.indexOf(s);
    if (i >= 0) return i;
    strs.push(s);
    return strs.length - 1;
  };
  const corpo = itens
    .map(([cod, desc, un, est], n) => {
      const r = 6 + n;
      return `<x:row r="${r}"><x:c r="A${r}"><x:v>${cod}</x:v></x:c><x:c r="D${r}" t="s"><x:v>${idx(desc)}</x:v></x:c><x:c r="J${r}" t="s"><x:v>${idx(un)}</x:v></x:c><x:c r="Q${r}"><x:v>${est}</x:v></x:c></x:row>`;
    })
    .join("");
  const cabecalho = `<x:row r="4"><x:c r="A4" t="s"><x:v>0</x:v></x:c><x:c r="D4" t="s"><x:v>1</x:v></x:c><x:c r="J4" t="s"><x:v>2</x:v></x:c><x:c r="Q4" t="s"><x:v>3</x:v></x:c></x:row>`;
  const sheet = `<?xml version="1.0"?><x:worksheet xmlns:x="s"><x:sheetData>${cabecalho}${corpo}</x:sheetData></x:worksheet>`;
  const shared = `<?xml version="1.0"?><x:sst xmlns:x="s">${strs.map((s) => `<x:si><x:t>${s}</x:t></x:si>`).join("")}</x:sst>`;
  return zipSync({
    "xl/sharedStrings.xml": strToU8(shared),
    "xl/worksheets/sheet.xml": strToU8(sheet),
  });
}

descrever("importarCatalogo", () => {
  let pool: Pool;
  let dir: string;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await semear(pool);
    dir = mkdtempSync(join(tmpdir(), "cat-"));
    await pool.query("delete from agente.produtos");
  });

  afterAll(async () => {
    await pool.query("delete from agente.produtos where codigo like 'T9%'");
    await pool.end();
  });

  it("insere produtos e grava a descrição normalizada e expandida", async () => {
    const caminho = join(dir, "a.xlsx");
    writeFileSync(caminho, planilhaFalsa([
      ["T901", "RET DIANT. TITAN160 VEDAMOTORS", "UND", 3],
      ["T902", "PASTILHA FREIO TRAS. CG160 25 FABRECK", "UND", 19],
    ]));

    const r = await importarCatalogo(pool, caminho);
    expect(r.lidos).toBe(2);
    expect(r.inseridos).toBe(2);

    const { rows } = await pool.query<{ descricao_norm: string; estoque: number }>(
      "select descricao_norm, estoque from agente.produtos where codigo = 'T901'",
    );
    expect(rows[0]!.descricao_norm).toBe("RETENTOR DIANTEIRO TITAN160 VEDAMOTORS");
    expect(rows[0]!.estoque).toBe(3);
  });

  it("atualiza estoque na segunda importação", async () => {
    const caminho = join(dir, "b.xlsx");
    writeFileSync(caminho, planilhaFalsa([
      ["T901", "RET DIANT. TITAN160 VEDAMOTORS", "UND", 7],
    ]));

    const r = await importarCatalogo(pool, caminho);
    expect(r.atualizados).toBe(1);

    const { rows } = await pool.query<{ estoque: number }>(
      "select estoque from agente.produtos where codigo = 'T901'",
    );
    expect(rows[0]!.estoque).toBe(7);
  });

  it("zera estoque de código ausente sem desativar o produto", async () => {
    const { rows } = await pool.query<{ estoque: number; ativo: boolean }>(
      "select estoque, ativo from agente.produtos where codigo = 'T902'",
    );
    expect(rows[0]!.estoque).toBe(0);
    expect(rows[0]!.ativo).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/integracao/importar.test.ts`
Expected: FAIL — `importarCatalogo` não existe.

- [ ] **Step 3: Implementar**

```ts
// src/catalogo/importar.ts
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { descompactar, parsearPlanilha, validarCabecalho } from "./planilha.js";
import { normalizar } from "./normalizar.js";
import { expandir } from "./expandir.js";
import { carregarSinonimos } from "../db/semear.js";

export interface ResultadoImport {
  lidos: number;
  inseridos: number;
  atualizados: number;
  zerados: number;
}

const LOTE = 500;

export async function importarCatalogo(
  pool: Pool,
  caminho: string,
): Promise<ResultadoImport> {
  const { sharedStrings, sheet } = descompactar(readFileSync(caminho));
  validarCabecalho(sharedStrings, sheet);
  const linhas = parsearPlanilha(sharedStrings, sheet);
  if (linhas.length === 0) {
    throw new Error("Relatório sem nenhuma linha de produto — importação abortada");
  }

  const sinonimos = await carregarSinonimos(pool);
  const cliente = await pool.connect();

  try {
    await cliente.query("begin");

    const { rows: antes } = await cliente.query<{ codigo: string }>(
      "select codigo from agente.produtos",
    );
    const existentes = new Set(antes.map((r) => r.codigo));

    for (let i = 0; i < linhas.length; i += LOTE) {
      const lote = linhas.slice(i, i + LOTE);
      const valores: unknown[] = [];
      const marcadores = lote.map((l, n) => {
        const b = n * 5;
        valores.push(
          l.codigo,
          l.descricao,
          expandir(normalizar(l.descricao), sinonimos),
          l.unidade,
          l.estoque,
        );
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });

      await cliente.query(
        `insert into agente.produtos (codigo, descricao, descricao_norm, unidade, estoque)
         values ${marcadores.join(",")}
         on conflict (codigo) do update set
           descricao      = excluded.descricao,
           descricao_norm = excluded.descricao_norm,
           unidade        = excluded.unidade,
           estoque        = excluded.estoque,
           ativo          = true,
           atualizado_em  = now()`,
        valores,
      );
    }

    const presentes = linhas.map((l) => l.codigo);
    const { rowCount: zerados } = await cliente.query(
      `update agente.produtos
          set estoque = 0, atualizado_em = now()
        where estoque <> 0 and codigo <> all($1::text[])`,
      [presentes],
    );

    await cliente.query("commit");

    const inseridos = linhas.filter((l) => !existentes.has(l.codigo)).length;
    return {
      lidos: linhas.length,
      inseridos,
      atualizados: linhas.length - inseridos,
      zerados: zerados ?? 0,
    };
  } catch (erro) {
    await cliente.query("rollback");
    throw erro;
  } finally {
    cliente.release();
  }
}
```

- [ ] **Step 4: Implementar o CLI**

```ts
// src/catalogo/cli.ts
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
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx vitest run tests/integracao/importar.test.ts`
Expected: 3 testes passando.

- [ ] **Step 6: Importar o catálogo real**

Run: `npm run catalogo:importar -- "$HOME/Downloads/RELATORIO ES.xlsx"`
Expected: `Lidos 5232 · inseridos 5232 · atualizados 0 · zerados 0`

- [ ] **Step 7: Commit**

```bash
git add src/catalogo/importar.ts src/catalogo/cli.ts tests/integracao/importar.test.ts
git commit -m "feat(catalogo): importador do relatorio de estoque com upsert por codigo"
```

---

### Task 9: Função de busca

**Files:**
- Create: `supabase/migrations/0002_buscar_peca.sql`, `src/busca/buscar.ts`
- Test: `tests/integracao/buscar.test.ts`

**Interfaces:**
- Consumes: `normalizar`, `expandir`, `carregarSinonimos`, catálogo importado
- Produces:
  - `interface Achado { id: string; codigo: string; descricao: string; unidade: string; estoque: number; fitment: "humano" | "auto" | "nenhum"; diasSemAtualizar: number; score: number }`
  - `buscarPeca(pool: Pool, texto: string, motoId?: string | null): Promise<Achado[]>`

O fitment ordena, não filtra: peça sem compatibilidade mapeada continua aparecendo, senão uma lacuna na extração viraria um "não tenho" falso.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/integracao/buscar.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { buscarPeca } from "../../src/busca/buscar.js";

const url = process.env.DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("buscarPeca", () => {
  let pool: Pool;
  beforeAll(() => { pool = criarPool(url!); });
  afterAll(async () => { await pool.end(); });

  it("acha por código exato com score máximo", async () => {
    const achados = await buscarPeca(pool, "2399");
    expect(achados[0]!.codigo).toBe("2399");
    expect(achados[0]!.score).toBe(1);
  });

  it("devolve no máximo 8 resultados", async () => {
    const achados = await buscarPeca(pool, "titan");
    expect(achados.length).toBeLessThanOrEqual(8);
  });

  it("devolve lista vazia para coisa que a loja não vende", async () => {
    const achados = await buscarPeca(pool, "geladeira brastemp duplex");
    expect(achados).toEqual([]);
  });

  it("traz dias sem atualizar para o agente decidir se afirma quantidade", async () => {
    const achados = await buscarPeca(pool, "2399");
    expect(achados[0]!.diasSemAtualizar).toBeGreaterThanOrEqual(0);
    expect(achados[0]!.fitment).toBe("nenhum");
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/integracao/buscar.test.ts`
Expected: FAIL — `buscarPeca` não existe.

- [ ] **Step 3: Escrever a migração da função**

```sql
-- supabase/migrations/0002_buscar_peca.sql

-- Limiar do operador % do pg_trgm. Calibrado na Task 10 contra o golden set.
alter database postgres set pg_trgm.similarity_threshold = 0.25;

create or replace function agente.buscar_peca(
  p_texto_norm text,
  p_codigo     text default null,
  p_moto_id    uuid default null
) returns table (
  id                 uuid,
  codigo             text,
  descricao          text,
  unidade            text,
  estoque            int,
  fitment            text,
  dias_sem_atualizar int,
  score              real
) language sql stable as $$
  select p.id,
         p.codigo,
         p.descricao,
         p.unidade,
         p.estoque,
         coalesce(pm.origem, 'nenhum')::text as fitment,
         extract(day from now() - p.atualizado_em)::int as dias_sem_atualizar,
         greatest(
           case
             when p_codigo is not null and p.codigo = p_codigo           then 1.0
             when p_codigo is not null and p.codigo like p_codigo || '%' then 0.9
             else 0
           end,
           similarity(p.descricao_norm, p_texto_norm)
         )::real as score
  from agente.produtos p
  left join agente.produto_moto pm
         on pm.produto_id = p.id
        and pm.moto_id = p_moto_id
  where p.ativo
    and (
      (p_codigo is not null and p.codigo like p_codigo || '%')
      or p.descricao_norm % p_texto_norm
    )
  order by (pm.origem = 'humano') desc nulls last,
           (pm.origem is not null) desc,
           score desc,
           p.estoque desc
  limit 8;
$$;
```

- [ ] **Step 4: Implementar o wrapper TypeScript**

```ts
// src/busca/buscar.ts
import type { Pool } from "pg";
import { normalizar } from "../catalogo/normalizar.js";
import { expandir } from "../catalogo/expandir.js";
import { carregarSinonimos } from "../db/semear.js";
import type { Sinonimos } from "../catalogo/expandir.js";

export interface Achado {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  estoque: number;
  fitment: "humano" | "auto" | "nenhum";
  diasSemAtualizar: number;
  score: number;
}

let cache: Sinonimos | null = null;

const SO_DIGITOS = /^\d{1,7}$/;

export async function buscarPeca(
  pool: Pool,
  texto: string,
  motoId: string | null = null,
): Promise<Achado[]> {
  cache ??= await carregarSinonimos(pool);

  const norm = normalizar(texto);
  if (norm === "") return [];

  const textoNorm = expandir(norm, cache);
  const codigo = SO_DIGITOS.test(norm) ? norm : null;

  const { rows } = await pool.query(
    "select * from agente.buscar_peca($1, $2, $3)",
    [textoNorm, codigo, motoId],
  );

  return rows.map((r) => ({
    id: r.id,
    codigo: r.codigo,
    descricao: r.descricao,
    unidade: r.unidade,
    estoque: r.estoque,
    fitment: r.fitment,
    diasSemAtualizar: r.dias_sem_atualizar,
    score: r.score,
  }));
}
```

- [ ] **Step 5: Aplicar e rodar**

Run: `npm run db:migrar && npx vitest run tests/integracao/buscar.test.ts`
Expected: 4 testes passando.

Estes quatro casos são determinísticos: código exato, teto de 8 resultados, consulta vazia e campos de retorno. A qualidade da busca por descrição não é medida aqui — é medida no golden set da Task 10, que existe exatamente para isso. Task 9 termina com a suíte verde.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0002_buscar_peca.sql src/busca/buscar.ts tests/integracao/buscar.test.ts
git commit -m "feat(busca): funcao buscar_peca com codigo, trigram e ordenacao por fitment"
```

---

### Task 10: Golden set e calibração — o portão do projeto

Este é o teste que decide se o projeto presta. Se a busca não encontra a peça do jeito que o cliente escreve, nada depois disso importa.

**Files:**
- Create: `tests/busca/golden-set.json`, `tests/busca/recall.test.ts`
- Modify: `package.json` (script `test:busca`)
- Modify: `supabase/seeds/sinonimos.sql` (conforme a calibração exigir)
- Modify: `supabase/migrations/0003_limiar.sql` (se o limiar precisar mudar)

**Interfaces:**
- Consumes: `buscarPeca` (Task 9)
- Produces: `npm run test:busca` imprimindo recall@1 e recall@3 e falhando abaixo da meta.

**Meta:** recall@3 ≥ 0,85 nas 50 consultas. Abaixo disso, não se avança para o plano do agente conversacional.

- [ ] **Step 1: Escrever o golden set**

40 entradas abaixo saíram do catálogo real, com códigos conferidos no arquivo do ERP. `esperado` é uma lista: quando a loja tem mais de um item que responde à pergunta, qualquer um deles conta como acerto.

```json
[
  { "consulta": "retentor de pinhão da falcon 400",        "esperado": ["2399"] },
  { "consulta": "pastilha de freio dianteira da biz 125",  "esperado": ["597"] },
  { "consulta": "pastilha traseira cg 160",                "esperado": ["598"] },
  { "consulta": "vela da nx400",                           "esperado": ["12536"] },
  { "consulta": "filtro de óleo da yes 125",               "esperado": ["1383"] },
  { "consulta": "filtro de gasolina",                      "esperado": ["167"] },
  { "consulta": "rolamento da árvore de comando titan",    "esperado": ["1222"] },
  { "consulta": "farol da yes",                            "esperado": ["720"] },
  { "consulta": "farol nxr 150 2010",                      "esperado": ["3984"] },
  { "consulta": "escape titan 150 cromado",                "esperado": ["1"] },
  { "consulta": "escape titam competição",                 "esperado": ["281"] },
  { "consulta": "corrente de transmissão xre 300",         "esperado": ["5564"] },
  { "consulta": "bateria dt 180",                          "esperado": ["1821", "46235"] },
  { "consulta": "pneu traseiro xtz 250",                   "esperado": ["120"] },
  { "consulta": "pneu dianteiro nxr borrachudo",           "esperado": ["731"] },
  { "consulta": "camara de ar neo 115",                    "esperado": ["4258"] },
  { "consulta": "lampada de farol titan led",              "esperado": ["2319"] },
  { "consulta": "cabo de acelerador fan 150",              "esperado": ["308"] },
  { "consulta": "manete de embreagem nxr 125",             "esperado": ["864"] },
  { "consulta": "manete de freio titan 125",               "esperado": ["947"] },
  { "consulta": "guidão cromado titan 160",                "esperado": ["5562"] },
  { "consulta": "amortecedor biz 125",                     "esperado": ["3617"] },
  { "consulta": "disco de freio dianteiro xre 300",        "esperado": ["91"] },
  { "consulta": "lona de freio traseira biz 100",          "esperado": ["508"] },
  { "consulta": "embreagem de partida nxr 160",            "esperado": ["13954"] },
  { "consulta": "carburador titan 150 2006",               "esperado": ["1150"] },
  { "consulta": "cdi da biz",                              "esperado": ["5645"] },
  { "consulta": "bobina de pulso titam 160",               "esperado": ["8905"] },
  { "consulta": "relé de pisca factor 250",                "esperado": ["9154"] },
  { "consulta": "bomba de combustível biz 110i",           "esperado": ["5311"] },
  { "consulta": "junta do cilindro titan",                 "esperado": ["102"] },
  { "consulta": "pistão titan 125 0.50",                   "esperado": ["1434"] },
  { "consulta": "anel de escape titan",                    "esperado": ["109"] },
  { "consulta": "kit relação fazer 250",                   "esperado": ["4540"] },
  { "consulta": "vidro do painel da biz 125",              "esperado": ["6"] },
  { "consulta": "retrovisor olho de gato preto",           "esperado": ["505", "544"] },
  { "consulta": "mola do pedal de freio nxr",              "esperado": ["208"] },
  { "consulta": "bucha da coroa titan 125",                "esperado": ["207"] },
  { "consulta": "veda rosca",                              "esperado": ["11"] },
  { "consulta": "protetor de braço de câmbio",             "esperado": ["27"] }
]
```

- [ ] **Step 2: Completar com 10 consultas reais**

Abra o WhatsApp da loja, pegue **10 perguntas reais de cliente** do último mês, ache o código correspondente no ERP e acrescente ao arquivo. Consulta inventada testa o que você imagina; consulta real testa o que acontece.

Se não houver acesso ao histórico agora, siga com as 40 e registre a pendência — mas as 10 reais precisam entrar antes do piloto.

- [ ] **Step 3: Escrever o teste de recall**

```ts
// tests/busca/recall.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { buscarPeca } from "../../src/busca/buscar.js";
import golden from "./golden-set.json" with { type: "json" };

const url = process.env.DATABASE_URL;
const descrever = url ? describe : describe.skip;

const META_RECALL_3 = 0.85;

descrever("recall do golden set", () => {
  let pool: Pool;
  beforeAll(() => { pool = criarPool(url!); });
  afterAll(async () => { await pool.end(); });

  it(`acerta pelo menos ${META_RECALL_3 * 100}% no topo 3`, async () => {
    let no1 = 0;
    let no3 = 0;
    const falhas: string[] = [];

    for (const caso of golden as Array<{ consulta: string; esperado: string[] }>) {
      const achados = await buscarPeca(pool, caso.consulta);
      const codigos = achados.map((a) => a.codigo);
      const acertou1 = codigos.length > 0 && caso.esperado.includes(codigos[0]!);
      const acertou3 = codigos.slice(0, 3).some((c) => caso.esperado.includes(c));
      if (acertou1) no1 += 1;
      if (acertou3) no3 += 1;
      else falhas.push(`${caso.consulta} → esperava ${caso.esperado.join("|")}, veio ${codigos.slice(0, 3).join("|") || "nada"}`);
    }

    const total = (golden as unknown[]).length;
    console.log(`recall@1 ${(no1 / total * 100).toFixed(1)}%  ·  recall@3 ${(no3 / total * 100).toFixed(1)}%`);
    if (falhas.length > 0) console.log("Falhas:\n" + falhas.join("\n"));

    expect(no3 / total).toBeGreaterThanOrEqual(META_RECALL_3);
  }, 60_000);
});
```

- [ ] **Step 4: Adicionar o script**

Em `"scripts"` do `package.json`:

```json
"test:busca": "vitest run tests/busca/recall.test.ts"
```

- [ ] **Step 5: Rodar e ver onde falha**

Run: `npm run test:busca`
Expected: provavelmente FAIL na primeira execução. A saída lista cada falha com o que veio no lugar. Isso é o dado de calibração.

- [ ] **Step 6: Calibrar**

Para cada falha, aplique **uma** correção e rode de novo:

1. **Falta um sinônimo?** Acrescente em `supabase/seeds/sinonimos.sql`, rode `npm run db:seed`, depois reimporte (`npm run catalogo:importar -- ...`) — o `descricao_norm` é gravado no import e precisa ser regerado.
2. **O limiar está apertado ou frouxo?** Crie `supabase/migrations/0003_limiar.sql` com `alter database postgres set pg_trgm.similarity_threshold = <valor>;`, reconecte e rode de novo. Comece testando 0,20 e 0,30 antes de tentar valores extremos.
3. **A consulta é ambígua de verdade?** Se um humano do balcão também não saberia responder, ajuste o `esperado` para aceitar os códigos plausíveis. Isso é legítimo; afrouxar o teste para esconder busca ruim, não.

Registre no commit qual mudança moveu qual número.

- [ ] **Step 7: Confirmar a meta**

Run: `npm run test:busca`
Expected: PASS, com recall@3 ≥ 85% impresso no console.

- [ ] **Step 8: Commit**

```bash
git add tests/busca package.json supabase/seeds/sinonimos.sql supabase/migrations/
git commit -m "test(busca): golden set com consultas reais e meta de recall@3"
```

---

### Task 11: Extração de compatibilidade com Haiku

As descrições já trazem os modelos (`RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA` serve em cinco famílias). Esta task lê as 5.232 descrições em lote e preenche `produto_moto` com `origem = 'auto'`.

**Ponto que não pode ser esquecido:** `origem = 'auto'` **nunca** autoriza o agente a afirmar compatibilidade. É pista de ordenação. Só `origem = 'humano'`, preenchido pelo balcão com o tempo, libera "serve sim". Está no spec e será cobrado nos testes de aceite do próximo plano.

**Files:**
- Create: `src/catalogo/fitment.ts`
- Test: `tests/unit/fitment.test.ts`, `tests/integracao/fitment.test.ts`
- Modify: `package.json` (script `catalogo:fitment`)

**Interfaces:**
- Consumes: `criarPool`, `lerEnv`, catálogo importado, `agente.motos` semeada
- Produces:
  - `interface ModeloExtraido { modelo: string; cilindrada: number | null }`
  - `extrairModelos(descricoes: string[], apiKey: string): Promise<Map<string, ModeloExtraido[]>>` — chave é a descrição
  - `casarComFrota(extraidos: ModeloExtraido[], frota: LinhaMoto[]): string[]` — devolve `moto_id`s; puro, testável sem rede
  - `popularFitment(pool: Pool, apiKey: string): Promise<{ produtos: number; vinculos: number; semCasar: number }>`

- [ ] **Step 1: Escrever o teste unitário do casamento**

```ts
// tests/unit/fitment.test.ts
import { describe, expect, it } from "vitest";
import { casarComFrota, type LinhaMoto } from "../../src/catalogo/fitment.js";

const FROTA: LinhaMoto[] = [
  { id: "m1", marca: "honda", modelo: "titan", cilindrada: 150 },
  { id: "m2", marca: "honda", modelo: "titan", cilindrada: 160 },
  { id: "m3", marca: "honda", modelo: "biz",   cilindrada: 125 },
  { id: "m4", marca: "honda", modelo: "bros",  cilindrada: 150 },
];

describe("casarComFrota", () => {
  it("casa modelo e cilindrada exatos", () => {
    expect(casarComFrota([{ modelo: "titan", cilindrada: 160 }], FROTA)).toEqual(["m2"]);
  });

  it("casa todas as cilindradas quando a descrição não diz qual", () => {
    expect(casarComFrota([{ modelo: "titan", cilindrada: null }], FROTA).sort())
      .toEqual(["m1", "m2"]);
  });

  it("casa vários modelos de uma descrição só", () => {
    const r = casarComFrota(
      [{ modelo: "biz", cilindrada: 125 }, { modelo: "bros", cilindrada: 150 }],
      FROTA,
    );
    expect(r.sort()).toEqual(["m3", "m4"]);
  });

  it("descarta modelo que não está na frota cadastrada", () => {
    expect(casarComFrota([{ modelo: "cbr", cilindrada: 1000 }], FROTA)).toEqual([]);
  });

  it("não repete o mesmo id", () => {
    const r = casarComFrota(
      [{ modelo: "titan", cilindrada: 160 }, { modelo: "titan", cilindrada: 160 }],
      FROTA,
    );
    expect(r).toEqual(["m2"]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/unit/fitment.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/catalogo/fitment.ts
import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";

export interface ModeloExtraido {
  modelo: string;
  cilindrada: number | null;
}

export interface LinhaMoto {
  id: string;
  marca: string;
  modelo: string;
  cilindrada: number | null;
}

const MODELO_HAIKU = "claude-haiku-4-5-20251001";
const LOTE = 40;

const INSTRUCAO = `Você recebe descrições de peças de moto de uma loja brasileira.
Para cada descrição, extraia os modelos de moto em que a peça se aplica.

Regras:
- Modelo em minúsculas, sem cilindrada junto: "TITAN150" vira {"modelo":"titan","cilindrada":150}.
- Barra separa modelos: "TITAN/XLR/XR" são três modelos distintos.
- Sem cilindrada explícita, use null.
- Nome de fabricante da peça (FORTUNA, VEDAMOTORS, NGK, FABRECK, COSER, MHX, SCT) não é modelo de moto.
- Peça universal, sem modelo nenhum, devolve lista vazia.

Responda SOMENTE com JSON, sem cerca de código, no formato:
[{"i":0,"modelos":[{"modelo":"titan","cilindrada":150}]}]
onde "i" é o índice da descrição na lista recebida.`;

export async function extrairModelos(
  descricoes: string[],
  apiKey: string,
): Promise<Map<string, ModeloExtraido[]>> {
  const cliente = new Anthropic({ apiKey });
  const saida = new Map<string, ModeloExtraido[]>();

  for (let i = 0; i < descricoes.length; i += LOTE) {
    const lote = descricoes.slice(i, i + LOTE);
    const resposta = await cliente.messages.create({
      model: MODELO_HAIKU,
      max_tokens: 4096,
      system: INSTRUCAO,
      messages: [
        {
          role: "user",
          content: lote.map((d, n) => `${n}: ${d}`).join("\n"),
        },
      ],
    });

    const bloco = resposta.content.find((b) => b.type === "text");
    if (!bloco || bloco.type !== "text") continue;

    let itens: Array<{ i: number; modelos: ModeloExtraido[] }>;
    try {
      itens = JSON.parse(bloco.text.trim());
    } catch {
      console.warn(`Lote ${i} devolveu JSON inválido; pulando.`);
      continue;
    }

    for (const item of itens) {
      const descricao = lote[item.i];
      if (descricao !== undefined) saida.set(descricao, item.modelos ?? []);
    }
  }

  return saida;
}

export function casarComFrota(
  extraidos: ModeloExtraido[],
  frota: LinhaMoto[],
): string[] {
  const ids = new Set<string>();
  for (const e of extraidos) {
    for (const moto of frota) {
      if (moto.modelo !== e.modelo) continue;
      if (e.cilindrada !== null && moto.cilindrada !== e.cilindrada) continue;
      ids.add(moto.id);
    }
  }
  return [...ids];
}

export async function popularFitment(
  pool: Pool,
  apiKey: string,
): Promise<{ produtos: number; vinculos: number; semCasar: number }> {
  const { rows: frota } = await pool.query<LinhaMoto>(
    "select id, marca, modelo, cilindrada from agente.motos",
  );
  const { rows: produtos } = await pool.query<{ id: string; descricao: string }>(
    "select id, descricao from agente.produtos where ativo",
  );

  const extraidos = await extrairModelos(
    produtos.map((p) => p.descricao),
    apiKey,
  );

  let vinculos = 0;
  let semCasar = 0;

  for (const produto of produtos) {
    const modelos = extraidos.get(produto.descricao) ?? [];
    const motoIds = casarComFrota(modelos, frota);
    if (motoIds.length === 0) {
      semCasar += 1;
      continue;
    }
    for (const motoId of motoIds) {
      await pool.query(
        `insert into agente.produto_moto (produto_id, moto_id, origem, confianca)
         values ($1, $2, 'auto', 0.7)
         on conflict (produto_id, moto_id) do nothing`,
        [produto.id, motoId],
      );
      vinculos += 1;
    }
  }

  return { produtos: produtos.length, vinculos, semCasar };
}
```

- [ ] **Step 4: Rodar o teste unitário**

Run: `npx vitest run tests/unit/fitment.test.ts`
Expected: 5 testes passando.

- [ ] **Step 5: Escrever o teste de integração**

```ts
// tests/integracao/fitment.test.ts
import { describe, expect, it } from "vitest";
import { extrairModelos } from "../../src/catalogo/fitment.js";

const chave = process.env.ANTHROPIC_API_KEY;
const descrever = chave ? describe : describe.skip;

descrever("extrairModelos", () => {
  it("extrai modelo e cilindrada de descrições reais do ERP", async () => {
    const mapa = await extrairModelos(
      [
        "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA",
        "RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA",
        "FITA VEDA ROSCA 12/10  MAX PARTS",
      ],
      chave!,
    );

    expect(mapa.get("ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA"))
      .toEqual([{ modelo: "titan", cilindrada: 150 }]);

    const multi = mapa.get("RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA") ?? [];
    expect(multi.map((m) => m.modelo).sort()).toEqual(["cbx", "nx", "titan", "xr"]);

    expect(mapa.get("FITA VEDA ROSCA 12/10  MAX PARTS")).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 6: Rodar o teste de integração**

Run: `npx vitest run tests/integracao/fitment.test.ts`
Expected: 1 teste passando. Se o modelo devolver formato diferente, ajuste `INSTRUCAO` — não o teste.

- [ ] **Step 7: Adicionar o script e o entrypoint**

Em `"scripts"` do `package.json`:

```json
"catalogo:fitment": "tsx src/catalogo/rodar-fitment.ts"
```

```ts
// src/catalogo/rodar-fitment.ts
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
```

- [ ] **Step 8: Rodar sobre o catálogo real**

Run: `npm run catalogo:fitment`
Expected: algo como `Produtos 5232 · vínculos criados ~9000 · sem casar ~1200`. Custo esperado em torno de US$ 2.

Peças universais (fita veda rosca, parafuso, óleo) caem legitimamente em "sem casar". Se "sem casar" passar de 40% do catálogo, revise `INSTRUCAO` e o seed de `motos` antes de seguir.

- [ ] **Step 9: Confirmar que a busca melhorou com fitment**

Run: `npm run test:busca`
Expected: recall igual ou melhor que antes. Fitment ordena, então não deve piorar nada.

- [ ] **Step 10: Commit**

```bash
git add src/catalogo/fitment.ts src/catalogo/rodar-fitment.ts tests/unit/fitment.test.ts tests/integracao/fitment.test.ts package.json
git commit -m "feat(catalogo): extracao automatica de compatibilidade com haiku"
```

---

## Definição de pronto deste plano

- `npm test` verde: unitários e integração.
- `npm run test:busca` com recall@3 ≥ 85% impresso.
- Catálogo real importado: 5.232 produtos em `agente.produtos`.
- `agente.produto_moto` populada com `origem = 'auto'`.
- `npm run typecheck` limpo.
- Golden set com pelo menos 10 consultas reais tiradas do WhatsApp da loja.

Cumprido isso, o portão F2 do spec está vencido e o plano seguinte (gateway Evolution, laço de conversa com Claude, ferramentas, resiliência, testes de aceite) pode começar.

## O que fica para o próximo plano

Fases F3 a F7 do spec: VPS e Docker Compose com Evolution API, gateway de webhook com idempotência e debounce, silêncio por `fromMe`, laço de conversa com Claude Sonnet 5, as 5 ferramentas, resiliência com retries e kill switch, os 12 testes de aceite e o cron da lista de compra.

Esse plano é escrito **depois** que este terminar, porque a calibração da busca define o contrato real da ferramenta `buscar_peca` — quantos resultados devolver, que campos o modelo precisa ver, quando um resultado conta como ambíguo. Escrever isso agora seria chutar.
