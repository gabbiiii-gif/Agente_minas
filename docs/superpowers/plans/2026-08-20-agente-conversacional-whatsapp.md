# Agente conversacional no WhatsApp — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ligar o catálogo já calibrado ao WhatsApp da loja: receber a mensagem do cliente, descobrir moto e peça conversando, consultar a busca e entregar ao balcão um pedido qualificado — sem nunca falar preço nem quantidade.

**Architecture:** Um processo Node sempre ligado (Fastify) recebe o webhook do Evolution API, resolve contato e conversa no Postgres, aplica debounce, e roda um laço de tool-calling com Claude Sonnet 5. As cinco ferramentas expostas ao modelo são a única porta para o banco. A resposta sai pelo Evolution dividida em partes, com atrasos. O importador de catálogo do plano anterior continua sendo CLI de máquina de desenvolvedor e não roda na VPS.

**Tech Stack:** Node 20+, TypeScript 5 (ESM), Fastify 5, `pg`, `@anthropic-ai/sdk` 0.120+, `zod`, vitest, Docker Compose (Evolution API + Postgres + Redis).

---

## O que já existe (plano anterior)

Este plano assume a fundação pronta e medida:

- `agente.produtos` com 5.232 SKUs importados do relatório do ERP.
- `agente.buscar_peca(p_texto_norm, p_codigo, p_moto_id)` calibrada: **recall@1 82,5% · recall@3 100%** contra o golden set de 40 consultas.
- `buscarPeca(pool, texto, motoId)` em `src/busca/buscar.ts`, devolvendo até 8 `Achado` com `codigo`, `descricao`, `unidade`, `estoque`, `fitment`, `diasSemAtualizar`, `score`.
- `agente.motos` com 33 modelos e apelidos; `agente.sinonimos` com 37 termos.
- `agente.produto_moto` com 5.339 vínculos `origem = 'auto'` (2.504 produtos ainda pendentes de extração — ver Task 0).
- Tabelas de conversa (`contatos`, `conversas`, `mensagens`, `demanda_nao_atendida`, `config`, `saidas_pendentes`) **já criadas** pela migração `0001_schema.sql`, ainda sem uso.

## Decisão de contrato que este plano fecha

O plano anterior terminou dizendo que o contrato real da ferramenta `buscar_peca` só poderia ser escrito depois da calibração, porque a calibração define quantos resultados devolver e quando um resultado conta como ambíguo. Com recall@1 82,5% e recall@3 100%, a resposta é:

**A ferramenta devolve os 3 primeiros resultados, não o primeiro.** Em 1 de cada 5 consultas o item certo não é o primeiro, mas em 40 de 40 ele está entre os três — quase sempre porque a loja tem o mesmo item de fabricantes diferentes. Entregar só o topo faria o agente afirmar a peça errada uma vez a cada cinco atendimentos; entregar três deixa o modelo confirmar com o cliente.

**A ferramenta não devolve `estoque` ao modelo.** Devolve `tem: boolean`. A regra "o agente nunca diz quantidade" vira estrutural em vez de depender do prompt obedecer: o número não entra no contexto, então não há o que vazar. Mesma lógica que já vale para preço, que não existe em lugar nenhum do domínio.

**A ferramenta não devolve `score`.** Score é dado de calibração, não de conversa; expor convida o modelo a raciocinar sobre número que ele não sabe interpretar. A ambiguidade é sinalizada por um campo próprio, `ambiguo`, calculado no servidor.

## Global Constraints

- Node 20 ou superior. TypeScript 5, ESM. Identificadores em português.
- **Preço não existe.** Nenhuma coluna, campo, string ou prompt menciona valor.
- **Quantidade não sai da ferramenta.** `estoque` é usado no servidor para calcular `tem`; nunca vai para o modelo nem para o cliente.
- Acesso ao Postgres só por `pg` com `DATABASE_URL`.
- Todo módulo puro tem teste unitário sem rede. Teste que escreve usa `TEST_DATABASE_URL`.
- O agente **nunca inicia conversa**. Só responde. O relatório diário vai para o número do dono.
- Mensagens de commit em português, formato convencional.
- Comentários curtos no código explicando o que a parte faz e por que existe — vale para toda função exportada e para toda constante cujo valor não é óbvio.

## Restrições da API que valem para este plano

Claude Sonnet 5 (`claude-sonnet-5`) mudou de superfície em relação a modelos anteriores. Errar qualquer um destes pontos devolve HTTP 400:

| Item | Regra |
|---|---|
| Thinking | `thinking: {type: "adaptive"}` é o único modo ligado. `budget_tokens` foi removido. |
| `temperature`, `top_p`, `top_k` | **Removidos.** Enviar qualquer um devolve 400. Não tente "baixar a temperatura" para o agente ficar previsível — use o prompt. |
| Prefill de assistant | Removido. Não dá para forçar formato prefixando a resposta; use instrução no system. |
| System no meio da conversa | Não suportado no Sonnet 5. Instrução de operador vai no `system` de topo. |
| Esforço | `output_config: {effort: ...}` — este plano usa `"medium"`, calibrável na Task 14. |

Modelo de import (`claude-haiku-4-5`) continua igual ao plano anterior.

## Aprendizados do plano anterior que se aplicam aqui

Custaram tempo uma vez; não devem custar duas:

- **Entrypoint no Windows.** `import.meta.url === \`file://${process.argv[1]}\`` nunca casa em caminho `C:\`. Use `pathToFileURL(process.argv[1]).href`.
- **`.env` não se carrega sozinho.** Scripts usam `tsx --env-file-if-exists=.env`; o vitest carrega por `tests/setup-env.ts`.
- **Nunca use `alter database ... set` para GUC.** O shared pooler do Supabase reaproveita conexões e o valor volta ao padrão em produção sem avisar. Prenda na função com `set` na definição.
- **Não deixe o repositório dentro do OneDrive.** Objetos do `.git` viram placeholder de nuvem e o git quebra com `mmap failed: Invalid argument` quando o OneDrive não está rodando. Antes de começar este plano, mova o repositório para um caminho local (`C:\dev\minas-agente`).

---

## Estrutura de arquivos

```
minas-agente/
├─ docker-compose.yml            Evolution API + postgres + redis (VPS)
├─ src/
│  ├─ config/env.ts              +EVOLUTION_*, TELEFONE_DONO, PORTA
│  ├─ gateway/
│  │  ├─ servidor.ts             Fastify: POST /webhook, GET /saude
│  │  ├─ payload.ts              lê o evento do Evolution (puro)
│  │  └─ debounce.ts             janela de 8s por conversa (puro)
│  ├─ conversa/
│  │  ├─ telefone.ts             normaliza para E.164 (puro)
│  │  ├─ contatos.ts             resolve contato, silêncio, teto de novos
│  │  └─ historico.ts            conversa ativa, grava mensagem, últimas 12
│  ├─ agente/
│  │  ├─ prompt.ts               system prompt montado com contexto
│  │  ├─ laco.ts                 laço de tool-calling, máximo 5 iterações
│  │  └─ modelo.ts               cliente Anthropic com retry
│  ├─ ferramentas/
│  │  ├─ definicoes.ts           schema das 5 tools
│  │  └─ executar.ts             despacha tool_use para o código
│  ├─ saida/
│  │  ├─ dividir.ts              parte em ~280 caracteres (puro)
│  │  └─ evolution.ts            envia, com retry e saidas_pendentes
│  └─ relatorio/
│     └─ diario.ts               CLI da lista de compra das 07h
└─ tests/
   ├─ unit/                      telefone, payload, debounce, dividir, prompt
   ├─ integracao/                contatos, historico, ferramentas, gateway
   └─ aceite/                    12 casos contra o modelo real
```

---

### Task 0: Fechar as pendências da fundação

Duas coisas ficaram abertas no plano anterior e as duas afetam a qualidade do que vem agora. Nenhuma é de código.

- [ ] **Step 1: Completar o fitment**

Recarregue os créditos da API Anthropic e rode:

```bash
npm run catalogo:fitment
```

Processa só os 2.504 produtos pendentes (~63 lotes, ~US$ 1). Já é retomável: produto que o modelo respondeu tem `fitment_em` preenchido e não volta.

Expected: `Produtos 2504 · vínculos criados N · sem casar M`, com `sem casar` alto — peça universal (fita veda rosca, parafuso, óleo) legitimamente não casa com moto.

- [ ] **Step 2: Colocar as 10 consultas reais no golden set**

Abra o WhatsApp da loja, pegue **10 perguntas reais de cliente** do último mês, ache o código no ERP e acrescente a `tests/busca/golden-set.json`.

```bash
npm run test:busca
```

Expected: recall@3 continua ≥ 85% com 50 consultas. Se cair, é sinal de que o vocabulário real do cliente tem padrão que as 40 consultas escritas não cobriam — calibre pelo procedimento da Task 10 do plano anterior antes de seguir.

Este passo é o que separa "a busca funciona no meu teste" de "a busca funciona para quem escreve pra loja". Não pule.

- [ ] **Step 3: Commit**

```bash
git add tests/busca/golden-set.json
git commit -m "test(busca): consultas reais do whatsapp no golden set"
```

---

### Task 1: Infraestrutura do WhatsApp na VPS

Antes de qualquer código: subir o Evolution e parear o número. Sem isso não há como capturar o payload real, e o payload real é a base da Task 3.

**Files:**
- Create: `docker-compose.yml`, `.env.example` (novas variáveis)

- [ ] **Step 1: Exportar o histórico do número**

O número da loja tem anos de histórico e conexão não oficial implica risco de banimento. Antes de ligar qualquer automação, exporte as conversas pelo próprio WhatsApp (Configurações → Conversas → Exportar). Este passo não tem volta depois.

- [ ] **Step 2: Subir Evolution, Postgres e Redis**

```yaml
# docker-compose.yml
services:
  evolution:
    image: atendai/evolution-api:v2.2.3
    restart: always
    ports:
      - "8080:8080"
    environment:
      AUTHENTICATION_API_KEY: ${EVOLUTION_API_KEY}
      DATABASE_ENABLED: "true"
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://evolution:${EVOLUTION_DB_SENHA}@evolution-db:5432/evolution
      CACHE_REDIS_ENABLED: "true"
      CACHE_REDIS_URI: redis://evolution-redis:6379
      CONFIG_SESSION_PHONE_VERSION: "2.3000.1023204200"
    depends_on: [evolution-db, evolution-redis]
    volumes:
      - evolution_instances:/evolution/instances

  evolution-db:
    image: postgres:16
    restart: always
    environment:
      POSTGRES_USER: evolution
      POSTGRES_PASSWORD: ${EVOLUTION_DB_SENHA}
      POSTGRES_DB: evolution
    volumes:
      - evolution_db:/var/lib/postgresql/data

  evolution-redis:
    image: redis:7-alpine
    restart: always
    volumes:
      - evolution_redis:/data

volumes:
  evolution_instances:
  evolution_db:
  evolution_redis:
```

Run: `docker compose up -d && docker compose ps`

`CONFIG_SESSION_PHONE_VERSION` precisa acompanhar a versão do WhatsApp Web; desatualizada, o pareamento falha com erro genérico. Confira a atual antes de subir.

- [ ] **Step 3: Criar a instância e parear**

```bash
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{"instanceName":"minas","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```

Leia o QR code com o WhatsApp da loja. Confirme com `GET /instance/connectionState/minas` até vir `open`.

- [ ] **Step 4: Acrescentar as variáveis ao `.env.example`**

```
# Evolution API (VPS)
EVOLUTION_URL=http://localhost:8080
EVOLUTION_API_KEY=troque-esta-chave
EVOLUTION_INSTANCIA=minas

# Número do dono, para relatório e alerta de falha. E.164, sem +.
TELEFONE_DONO=5593999999999

# Porta do serviço que recebe o webhook
PORTA=3000

# Segredo que o Evolution manda no header do webhook; o gateway recusa sem ele.
WEBHOOK_SEGREDO=troque-este-segredo
```

- [ ] **Step 5: Capturar o payload real**

Aponte o webhook para um coletor temporário e mande três mensagens de um celular pessoal para o número da loja: uma de texto, uma foto com legenda e uma mensagem em grupo.

```bash
npx --yes http-echo-server 3000 > payloads.txt &
curl -X POST http://localhost:8080/webhook/set/minas \
  -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true,"url":"http://SEU_IP:3000/webhook","webhookByEvents":false,"webhookBase64":true,"events":["MESSAGES_UPSERT"]}'
```

Guarde os três payloads em `tests/unit/fixtures/`. **Eles são a fonte de verdade da Task 3** — o formato varia entre versões do Evolution, e teste escrito contra payload imaginado passa enquanto a produção quebra.

Expected: três arquivos JSON com envelope `{event, instance, data:{key:{remoteJid, fromMe, id}, pushName, message, messageType, messageTimestamp}}`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example tests/unit/fixtures/
git commit -m "chore(infra): evolution api na vps e payloads reais de webhook"
```

---

### Task 2: Telefone em E.164

Chave de identidade do contato. O Evolution manda `5593999998888@s.whatsapp.net`, o dono digita `(93) 99999-8888`, e os dois precisam virar a mesma linha na tabela.

**Files:**
- Create: `src/conversa/telefone.ts`
- Test: `tests/unit/telefone.test.ts`

**Interfaces:**
- Produces: `normalizarTelefone(bruto: string): string | null`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/telefone.test.ts
import { describe, expect, it } from "vitest";
import { normalizarTelefone } from "../../src/conversa/telefone.js";

describe("normalizarTelefone", () => {
  it("aceita o jid do evolution", () => {
    expect(normalizarTelefone("5593999998888@s.whatsapp.net")).toBe("5593999998888");
  });

  it("aceita número digitado com máscara", () => {
    expect(normalizarTelefone("(93) 99999-8888")).toBe("5593999998888");
  });

  it("completa o código do país quando falta", () => {
    expect(normalizarTelefone("93999998888")).toBe("5593999998888");
  });

  it("mantém o nono dígito de celular", () => {
    expect(normalizarTelefone("5593999998888")).toBe("5593999998888");
  });

  it("aceita fixo de oito dígitos", () => {
    expect(normalizarTelefone("559335151234")).toBe("559335151234");
  });

  it("recusa grupo", () => {
    expect(normalizarTelefone("12036304212345678@g.us")).toBeNull();
  });

  it("recusa status", () => {
    expect(normalizarTelefone("status@broadcast")).toBeNull();
  });

  it("recusa lixo", () => {
    expect(normalizarTelefone("abc")).toBeNull();
    expect(normalizarTelefone("")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run tests/unit/telefone.test.ts`

- [ ] **Step 3: Implementar**

```ts
// src/conversa/telefone.ts

/** Sufixos que o WhatsApp usa e que não são conversa de cliente. */
const NAO_E_PESSOA = /@g\.us$|@broadcast$|^status@/i;

/**
 * Reduz qualquer forma de telefone à chave usada em `agente.contatos`:
 * dígitos, com código do país, sem "+".
 *
 * Devolve null para grupo, status e lixo — é assim que o gateway descarta o
 * que não é atendimento, então null aqui significa "ignore esta mensagem".
 */
export function normalizarTelefone(bruto: string): string | null {
  if (bruto === "" || NAO_E_PESSOA.test(bruto)) return null;

  const digitos = bruto.replace(/\D/g, "");
  if (digitos.length < 10) return null;

  // Número local (DDD + 8 ou 9 dígitos) ganha o 55 do Brasil. A loja é de
  // Altamira e não atende de fora; se um dia atender, isto muda aqui.
  const comPais = digitos.length <= 11 ? `55${digitos}` : digitos;

  // 55 + DDD(2) + 8 ou 9 dígitos
  if (!/^55\d{10,11}$/.test(comPais)) return null;
  return comPais;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/telefone.test.ts && npm run typecheck`
Expected: 8 testes passando.

- [ ] **Step 5: Commit**

```bash
git add src/conversa/telefone.ts tests/unit/telefone.test.ts
git commit -m "feat(conversa): normalizacao de telefone para e164"
```

---

### Task 3: Leitura do payload do Evolution

Puro, sem rede: recebe o JSON do webhook e devolve ou uma mensagem tratável, ou o motivo do descarte. Todo o resto do gateway depende disso estar certo.

**Files:**
- Create: `src/gateway/payload.ts`
- Test: `tests/unit/payload.test.ts` (usando os fixtures da Task 1)

**Interfaces:**
- Produces:
  - `type Recebida = { tipo: "texto"; telefone: string; nome: string; texto: string; msgExtId: string; fromMe: boolean } | { tipo: "imagem"; telefone: string; nome: string; legenda: string; midiaBase64: string; mimetype: string; msgExtId: string; fromMe: boolean }`
  - `type Descarte = { descartar: string }`
  - `lerEvento(corpo: unknown): Recebida | Descarte`

- [ ] **Step 1: Escrever o teste que falha**

Os fixtures vieram da instância real na Task 1. Se você não tem os três arquivos, volte — não invente payload.

```ts
// tests/unit/payload.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { lerEvento } from "../../src/gateway/payload.js";

const fixture = (n: string) =>
  JSON.parse(readFileSync(`tests/unit/fixtures/${n}.json`, "utf8"));

describe("lerEvento", () => {
  it("lê mensagem de texto de cliente", () => {
    const r = lerEvento(fixture("texto"));
    expect(r).toMatchObject({ tipo: "texto", fromMe: false });
    if ("tipo" in r) {
      expect(r.telefone).toMatch(/^55\d{10,11}$/);
      expect(r.texto.length).toBeGreaterThan(0);
      expect(r.msgExtId.length).toBeGreaterThan(0);
    }
  });

  it("lê foto com legenda", () => {
    const r = lerEvento(fixture("imagem"));
    expect(r).toMatchObject({ tipo: "imagem" });
    if ("tipo" in r && r.tipo === "imagem") {
      expect(r.midiaBase64.length).toBeGreaterThan(100);
      expect(r.mimetype).toMatch(/^image\//);
    }
  });

  it("descarta mensagem de grupo", () => {
    expect(lerEvento(fixture("grupo"))).toEqual({ descartar: "grupo" });
  });

  it("descarta evento que não é mensagem", () => {
    expect(lerEvento({ event: "connection.update", data: {} }))
      .toEqual({ descartar: "evento ignorado: connection.update" });
  });

  it("descarta corpo vazio", () => {
    expect(lerEvento({ event: "messages.upsert", data: { key: { remoteJid: "5593999998888@s.whatsapp.net", id: "X", fromMe: false }, message: {} } }))
      .toEqual({ descartar: "sem conteúdo tratável" });
  });

  it("descarta áudio, que a v1 não trata", () => {
    expect(lerEvento({ event: "messages.upsert", data: { key: { remoteJid: "5593999998888@s.whatsapp.net", id: "X", fromMe: false }, message: { audioMessage: { seconds: 3 } }, messageType: "audioMessage" } }))
      .toEqual({ descartar: "audio" });
  });

  it("marca fromMe sem descartar — o gateway precisa saber para silenciar", () => {
    const r = lerEvento({
      event: "messages.upsert",
      data: { key: { remoteJid: "5593999998888@s.whatsapp.net", id: "Y", fromMe: true }, message: { conversation: "já separo" }, messageType: "conversation" },
    });
    expect(r).toMatchObject({ fromMe: true, tipo: "texto" });
  });

  it("descarta lixo sem explodir", () => {
    expect(lerEvento(null)).toHaveProperty("descartar");
    expect(lerEvento("x")).toHaveProperty("descartar");
    expect(lerEvento({})).toHaveProperty("descartar");
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar**

```ts
// src/gateway/payload.ts
import { normalizarTelefone } from "../conversa/telefone.js";

export type Recebida =
  | { tipo: "texto"; telefone: string; nome: string; texto: string; msgExtId: string; fromMe: boolean }
  | { tipo: "imagem"; telefone: string; nome: string; legenda: string; midiaBase64: string; mimetype: string; msgExtId: string; fromMe: boolean };

export type Descarte = { descartar: string };

/** O Evolution manda vários eventos no mesmo webhook; só um interessa. */
const EVENTO_MENSAGEM = "messages.upsert";

function texto(msg: Record<string, any>): string | null {
  if (typeof msg.conversation === "string") return msg.conversation;
  if (typeof msg.extendedTextMessage?.text === "string") return msg.extendedTextMessage.text;
  return null;
}

/**
 * Traduz o evento cru do Evolution para o que o gateway sabe tratar.
 *
 * Nunca lança: webhook que explode faz o Evolution reenviar em laço. Tudo que
 * não dá para tratar vira `{descartar: motivo}`, e o motivo vai para o log —
 * é assim que se descobre formato novo depois de atualizar o Evolution.
 */
export function lerEvento(corpo: unknown): Recebida | Descarte {
  if (corpo === null || typeof corpo !== "object") return { descartar: "corpo não é objeto" };

  const c = corpo as Record<string, any>;
  const evento = String(c.event ?? "");
  if (evento !== EVENTO_MENSAGEM) return { descartar: `evento ignorado: ${evento || "sem event"}` };

  const dados = c.data;
  if (!dados || typeof dados !== "object") return { descartar: "sem data" };

  const jid = String(dados.key?.remoteJid ?? "");
  if (/@g\.us$/i.test(jid)) return { descartar: "grupo" };

  const telefone = normalizarTelefone(jid);
  if (telefone === null) return { descartar: "remetente não é pessoa" };

  const msgExtId = String(dados.key?.id ?? "");
  if (msgExtId === "") return { descartar: "sem id de mensagem" };

  const fromMe = dados.key?.fromMe === true;
  const nome = String(dados.pushName ?? "");
  const msg = (dados.message ?? {}) as Record<string, any>;

  if (msg.audioMessage) return { descartar: "audio" };

  const corpoTexto = texto(msg);
  if (corpoTexto !== null && corpoTexto.trim() !== "") {
    return { tipo: "texto", telefone, nome, texto: corpoTexto.trim(), msgExtId, fromMe };
  }

  const img = msg.imageMessage;
  if (img) {
    // `webhookBase64: true` na configuração do webhook põe o arquivo em
    // data.message.base64. Sem isso só vem a URL criptografada do WhatsApp,
    // que não dá para baixar sem as chaves da sessão.
    const base64 = String(dados.message?.base64 ?? dados.base64 ?? "");
    if (base64 === "") return { descartar: "imagem sem base64 — confira webhookBase64 no webhook" };
    return {
      tipo: "imagem",
      telefone,
      nome,
      legenda: String(img.caption ?? "").trim(),
      midiaBase64: base64,
      mimetype: String(img.mimetype ?? "image/jpeg"),
      msgExtId,
      fromMe,
    };
  }

  return { descartar: "sem conteúdo tratável" };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run tests/unit/payload.test.ts && npm run typecheck`

Se algum teste falhar contra o fixture real, **corrija o código, não o fixture**. O fixture é o que a produção manda.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/payload.ts tests/unit/payload.test.ts
git commit -m "feat(gateway): leitura do evento de mensagem do evolution"
```
---

### Task 4: Contato, silêncio e teto de contatos novos

**Files:**
- Create: `src/conversa/contatos.ts`
- Test: `tests/integracao/contatos.test.ts`

**Interfaces:**
- Produces:
  - `resolverContato(pool, telefone, nome): Promise<Contato>` — cria se não existe
  - `estaSilenciado(contato, agora): boolean`
  - `silenciarPorHumano(pool, contatoId, agora): Promise<void>` — 6 horas
  - `contatosNovosNaUltimaHora(pool): Promise<number>`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/integracao/contatos.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import {
  resolverContato, estaSilenciado, silenciarPorHumano, contatosNovosNaUltimaHora,
} from "../../src/conversa/contatos.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("contatos", () => {
  let pool: Pool;
  const tel = "5593900000001";

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await pool.query("delete from agente.contatos where telefone like '55939000%'");
  });
  afterAll(async () => {
    await pool.query("delete from agente.contatos where telefone like '55939000%'");
    await pool.end();
  });

  it("cria o contato no primeiro contato e reaproveita depois", async () => {
    const a = await resolverContato(pool, tel, "Zé");
    const b = await resolverContato(pool, tel, "Zé da Moto");
    expect(b.id).toBe(a.id);
  });

  it("não apaga o nome quando o pushName vem vazio", async () => {
    await resolverContato(pool, tel, "Zé");
    const c = await resolverContato(pool, tel, "");
    expect(c.nome).toBe("Zé");
  });

  it("silencia por 6 horas quando o balcão responde", async () => {
    const c = await resolverContato(pool, tel, "Zé");
    const agora = new Date("2026-08-20T12:00:00Z");
    await silenciarPorHumano(pool, c.id, agora);

    const depois = await resolverContato(pool, tel, "Zé");
    expect(estaSilenciado(depois, new Date("2026-08-20T17:59:00Z"))).toBe(true);
    expect(estaSilenciado(depois, new Date("2026-08-20T18:01:00Z"))).toBe(false);
  });

  it("conta contatos novos da última hora para o teto anti-banimento", async () => {
    const antes = await contatosNovosNaUltimaHora(pool);
    await resolverContato(pool, "5593900000002", "Novo");
    expect(await contatosNovosNaUltimaHora(pool)).toBe(antes + 1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar**

```ts
// src/conversa/contatos.ts
import type { Pool } from "pg";

export interface Contato {
  id: string;
  telefone: string;
  nome: string | null;
  motoId: string | null;
  silenciadoAte: Date | null;
}

/**
 * Quanto tempo o bot fica calado depois que o balcão responde na conversa.
 * Renovado a cada mensagem humana: enquanto o atendente estiver ativo, o
 * silêncio se estende sozinho.
 */
const HORAS_DE_SILENCIO = 6;

/**
 * Acha o contato pelo telefone, criando se for a primeira mensagem dele.
 *
 * O nome só é sobrescrito quando vem preenchido — o pushName do WhatsApp às
 * vezes chega vazio, e não faz sentido apagar um nome que já se sabia.
 */
export async function resolverContato(
  pool: Pool,
  telefone: string,
  nome: string,
): Promise<Contato> {
  const { rows } = await pool.query(
    `insert into agente.contatos (telefone, nome)
     values ($1, nullif($2, ''))
     on conflict (telefone) do update
       set nome = coalesce(nullif($2, ''), agente.contatos.nome)
     returning id, telefone, nome, moto_id, silenciado_ate`,
    [telefone, nome],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    telefone: r.telefone,
    nome: r.nome,
    motoId: r.moto_id,
    silenciadoAte: r.silenciado_ate,
  };
}

/** Puro de propósito: o gateway decide calar sem ir ao banco de novo. */
export function estaSilenciado(contato: Contato, agora: Date): boolean {
  return contato.silenciadoAte !== null && contato.silenciadoAte > agora;
}

export async function silenciarPorHumano(
  pool: Pool,
  contatoId: string,
  agora: Date = new Date(),
): Promise<void> {
  const ate = new Date(agora.getTime() + HORAS_DE_SILENCIO * 3600_000);
  await pool.query(
    "update agente.contatos set silenciado_ate = $2 where id = $1",
    [contatoId, ate],
  );
}

/**
 * Quantos contatos novos apareceram na última hora.
 *
 * Serve ao teto anti-banimento: número não oficial que de repente fala com
 * muita gente nova é padrão que o WhatsApp pune.
 */
export async function contatosNovosNaUltimaHora(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from agente.contatos where criado_em > now() - interval '1 hour'",
  );
  return Number(rows[0]!.n);
}
```

- [ ] **Step 4: Rodar, confirmar e commitar**

```bash
npx vitest run tests/integracao/contatos.test.ts && npm run typecheck
git add src/conversa/contatos.ts tests/integracao/contatos.test.ts
git commit -m "feat(conversa): contato, silencio por humano e teto de novos"
```

---

### Task 5: Conversa, histórico e idempotência

**Files:**
- Create: `src/conversa/historico.ts`
- Test: `tests/integracao/historico.test.ts`

**Interfaces:**
- Produces:
  - `conversaAtiva(pool, contatoId): Promise<Conversa>`
  - `gravarMensagem(pool, m: NovaMensagem): Promise<boolean>` — `false` quando o `msg_ext_id` já existia
  - `ultimasMensagens(pool, conversaId, limite = 12): Promise<Mensagem[]>`
  - `marcarStatus(pool, conversaId, status, campos?): Promise<void>`

- [ ] **Step 1: Escrever o teste que falha**

O teste de idempotência é o mais importante: o Evolution reenvia o mesmo webhook quando não recebe 200 a tempo, e responder duas vezes à mesma mensagem é o erro que o cliente percebe na hora.

```ts
// tests/integracao/historico.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import { resolverContato } from "../../src/conversa/contatos.js";
import {
  conversaAtiva, gravarMensagem, ultimasMensagens, marcarStatus,
} from "../../src/conversa/historico.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("historico", () => {
  let pool: Pool;
  let contatoId: string;
  let conversaId: string;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await pool.query("delete from agente.contatos where telefone = '5593900000009'");
    contatoId = (await resolverContato(pool, "5593900000009", "Teste")).id;
    conversaId = (await conversaAtiva(pool, contatoId)).id;
  });
  afterAll(async () => {
    await pool.query("delete from agente.contatos where telefone = '5593900000009'");
    await pool.end();
  });

  it("reaproveita a conversa ativa em vez de abrir outra", async () => {
    const outra = await conversaAtiva(pool, contatoId);
    expect(outra.id).toBe(conversaId);
  });

  it("grava a mensagem do cliente", async () => {
    const ok = await gravarMensagem(pool, {
      conversaId, papel: "cliente", conteudo: "tem retentor?", msgExtId: "EXT-1",
    });
    expect(ok).toBe(true);
  });

  it("recusa o mesmo msg_ext_id — o evolution reenvia webhook", async () => {
    const ok = await gravarMensagem(pool, {
      conversaId, papel: "cliente", conteudo: "tem retentor?", msgExtId: "EXT-1",
    });
    expect(ok).toBe(false);
  });

  it("devolve as últimas mensagens em ordem cronológica", async () => {
    await gravarMensagem(pool, { conversaId, papel: "agente", conteudo: "Qual a moto?", msgExtId: "EXT-2" });
    const msgs = await ultimasMensagens(pool, conversaId, 12);
    expect(msgs.at(-1)!.conteudo).toBe("Qual a moto?");
    expect(msgs.at(-2)!.papel).toBe("cliente");
  });

  it("limita a janela ao tamanho pedido", async () => {
    for (let i = 0; i < 15; i++) {
      await gravarMensagem(pool, { conversaId, papel: "cliente", conteudo: `m${i}`, msgExtId: `EXT-L${i}` });
    }
    expect((await ultimasMensagens(pool, conversaId, 12)).length).toBe(12);
  });

  it("abre conversa nova depois que a anterior encerra", async () => {
    await marcarStatus(pool, conversaId, "encerrada", { desfecho: "qualificou" });
    const nova = await conversaAtiva(pool, contatoId);
    expect(nova.id).not.toBe(conversaId);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar**

```ts
// src/conversa/historico.ts
import type { Pool } from "pg";

export type Papel = "cliente" | "agente" | "humano" | "sistema";
export type Status = "ativa" | "aguardando_humano" | "encerrada";

export interface Conversa {
  id: string;
  status: Status;
  iniciadaEm: Date;
}

export interface NovaMensagem {
  conversaId: string;
  papel: Papel;
  conteudo: string;
  msgExtId?: string | null;
  tipoMidia?: "texto" | "imagem" | "audio";
  midiaUrl?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  modelo?: string | null;
}

export interface Mensagem {
  papel: Papel;
  conteudo: string;
  tipoMidia: string;
  criadoEm: Date;
}

/**
 * Devolve a conversa aberta do contato, criando uma se não houver.
 *
 * "Aberta" é status diferente de 'encerrada' — inclui 'aguardando_humano',
 * porque conversa que o balcão assumiu continua sendo a mesma conversa.
 */
export async function conversaAtiva(pool: Pool, contatoId: string): Promise<Conversa> {
  const { rows } = await pool.query(
    `select id, status, iniciada_em from agente.conversas
      where contato_id = $1 and status <> 'encerrada'
      order by iniciada_em desc limit 1`,
    [contatoId],
  );
  if (rows[0]) {
    return { id: rows[0].id, status: rows[0].status, iniciadaEm: rows[0].iniciada_em };
  }
  const nova = await pool.query(
    `insert into agente.conversas (contato_id) values ($1)
     returning id, status, iniciada_em`,
    [contatoId],
  );
  const r = nova.rows[0]!;
  return { id: r.id, status: r.status, iniciadaEm: r.iniciada_em };
}

/**
 * Grava a mensagem e diz se ela é nova.
 *
 * `false` significa que este `msg_ext_id` já estava no banco: o Evolution
 * reenviou o webhook. Quem chama deve parar aí — responder duas vezes à
 * mesma mensagem é o erro que o cliente enxerga.
 */
export async function gravarMensagem(pool: Pool, m: NovaMensagem): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into agente.mensagens
       (conversa_id, papel, conteudo, tipo_midia, midia_url, msg_ext_id, tokens_in, tokens_out, modelo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (msg_ext_id) do nothing`,
    [
      m.conversaId, m.papel, m.conteudo, m.tipoMidia ?? "texto", m.midiaUrl ?? null,
      m.msgExtId ?? null, m.tokensIn ?? null, m.tokensOut ?? null, m.modelo ?? null,
    ],
  );

  if ((rowCount ?? 0) > 0) {
    await pool.query(
      "update agente.conversas set ultima_msg_em = now() where id = $1",
      [m.conversaId],
    );
    return true;
  }
  return false;
}

/** Janela de contexto entregue ao modelo, em ordem cronológica. */
export async function ultimasMensagens(
  pool: Pool,
  conversaId: string,
  limite = 12,
): Promise<Mensagem[]> {
  const { rows } = await pool.query(
    `select papel, conteudo, tipo_midia, criado_em from (
       select papel, conteudo, tipo_midia, criado_em from agente.mensagens
        where conversa_id = $1 order by criado_em desc, id desc limit $2
     ) t order by criado_em asc, papel asc`,
    [conversaId, limite],
  );
  return rows.map((r) => ({
    papel: r.papel, conteudo: r.conteudo ?? "", tipoMidia: r.tipo_midia, criadoEm: r.criado_em,
  }));
}

export async function marcarStatus(
  pool: Pool,
  conversaId: string,
  status: Status,
  campos: { intencao?: string; desfecho?: string; resumo?: string } = {},
): Promise<void> {
  await pool.query(
    `update agente.conversas
        set status = $2,
            intencao = coalesce($3, intencao),
            desfecho = coalesce($4, desfecho),
            resumo   = coalesce($5, resumo)
      where id = $1`,
    [conversaId, status, campos.intencao ?? null, campos.desfecho ?? null, campos.resumo ?? null],
  );
}
```

- [ ] **Step 4: Rodar, confirmar e commitar**

```bash
npx vitest run tests/integracao/historico.test.ts && npm run typecheck
git add src/conversa/historico.ts tests/integracao/historico.test.ts
git commit -m "feat(conversa): conversa ativa, historico e idempotencia por msg_ext_id"
```

---

### Task 6: Debounce de 8 segundos

Cliente manda "boa tarde", "tem retentor", "pra titan 160" em três mensagens seguidas. Sem debounce o agente responde três vezes e atropela a própria conversa.

**Files:**
- Create: `src/gateway/debounce.ts`
- Test: `tests/unit/debounce.test.ts`

**Interfaces:**
- Produces: `criarDebounce(esperaMs, aoDisparar): { registrar(chave: string): void; pendentes(): number; encerrar(): void }`

- [ ] **Step 1: Escrever o teste que falha**

Usa timers falsos do vitest: teste de tempo não pode depender de tempo real.

```ts
// tests/unit/debounce.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { criarDebounce } from "../../src/gateway/debounce.js";

describe("criarDebounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispara uma vez depois da janela", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => { visto.push(c); });
    d.registrar("conversa-1");
    vi.advanceTimersByTime(7999);
    expect(visto).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(visto).toEqual(["conversa-1"]);
  });

  it("mensagem nova reinicia a janela e junta tudo num turno só", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => { visto.push(c); });
    d.registrar("conversa-1");
    vi.advanceTimersByTime(5000);
    d.registrar("conversa-1");
    vi.advanceTimersByTime(5000);
    expect(visto).toEqual([]);        // a segunda reiniciou a contagem
    vi.advanceTimersByTime(3000);
    expect(visto).toEqual(["conversa-1"]);
  });

  it("conversas diferentes têm janelas independentes", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => { visto.push(c); });
    d.registrar("a");
    vi.advanceTimersByTime(4000);
    d.registrar("b");
    vi.advanceTimersByTime(4000);
    expect(visto).toEqual(["a"]);
    vi.advanceTimersByTime(4000);
    expect(visto).toEqual(["a", "b"]);
  });

  it("não deixa timer vazando depois de disparar", () => {
    const d = criarDebounce(8000, () => {});
    d.registrar("a");
    expect(d.pendentes()).toBe(1);
    vi.advanceTimersByTime(8000);
    expect(d.pendentes()).toBe(0);
  });

  it("encerrar cancela o que estava pendente", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => { visto.push(c); });
    d.registrar("a");
    d.encerrar();
    vi.advanceTimersByTime(20000);
    expect(visto).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar**

```ts
// src/gateway/debounce.ts

/**
 * Junta mensagens picadas num turno só.
 *
 * Cliente escreve como fala: "boa tarde", "tem retentor", "pra titan 160" em
 * três mensagens. Cada nova mensagem reinicia a contagem; quando o cliente
 * para de digitar por `esperaMs`, o turno dispara com tudo junto.
 *
 * Vive em memória de propósito: se o processo cair, a janela se perde e o
 * cliente reenvia — mais simples do que uma fila persistente para 8 segundos.
 */
export function criarDebounce(
  esperaMs: number,
  aoDisparar: (chave: string) => void,
): { registrar(chave: string): void; pendentes(): number; encerrar(): void } {
  const timers = new Map<string, NodeJS.Timeout>();

  return {
    registrar(chave: string): void {
      const anterior = timers.get(chave);
      if (anterior !== undefined) clearTimeout(anterior);

      timers.set(
        chave,
        setTimeout(() => {
          timers.delete(chave);
          aoDisparar(chave);
        }, esperaMs),
      );
    },
    pendentes: () => timers.size,
    encerrar(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
```

- [ ] **Step 4: Rodar, confirmar e commitar**

```bash
npx vitest run tests/unit/debounce.test.ts
git add src/gateway/debounce.ts tests/unit/debounce.test.ts
git commit -m "feat(gateway): debounce de 8s por conversa"
```

---

### Task 7: Divisão da resposta e envio pelo Evolution

**Files:**
- Create: `src/saida/dividir.ts`, `src/saida/evolution.ts`
- Test: `tests/unit/dividir.test.ts`

**Interfaces:**
- Produces:
  - `dividir(texto: string, max = 280): string[]`
  - `enviar(pool, cfg, telefone, texto): Promise<void>` — retry e `saidas_pendentes`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/dividir.test.ts
import { describe, expect, it } from "vitest";
import { dividir } from "../../src/saida/dividir.js";

describe("dividir", () => {
  it("devolve uma parte só quando cabe", () => {
    expect(dividir("Tem sim. Retentor dianteiro Fan 160, código 4402.")).toHaveLength(1);
  });

  it("quebra em parágrafo antes de quebrar em frase", () => {
    const partes = dividir("Primeira ideia aqui.\n\nSegunda ideia aqui.", 30);
    expect(partes).toEqual(["Primeira ideia aqui.", "Segunda ideia aqui."]);
  });

  it("quebra em fim de frase quando o parágrafo não cabe", () => {
    const partes = dividir("Tenho essa peça. Confirma comigo antes de vir.", 25);
    expect(partes[0]).toBe("Tenho essa peça.");
    expect(partes[1]).toBe("Confirma comigo antes de vir.");
  });

  it("nunca devolve parte vazia", () => {
    expect(dividir("a.\n\n\n\nb.", 10).every((p) => p.trim() !== "")).toBe(true);
  });

  it("corta palavra gigante em vez de entrar em laço", () => {
    const partes = dividir("x".repeat(700), 280);
    expect(partes).toHaveLength(3);
    expect(partes[0]!.length).toBe(280);
  });

  it("devolve lista vazia para texto vazio", () => {
    expect(dividir("   ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar a divisão**

```ts
// src/saida/dividir.ts

/**
 * Quebra a resposta em mensagens de WhatsApp.
 *
 * Parede de texto denuncia bot e cansa quem lê no celular. Quebra primeiro em
 * parágrafo, depois em fim de frase, e só corta no meio da palavra quando não
 * há alternativa — o que na prática só acontece com link ou código longo.
 */
export function dividir(texto: string, max = 280): string[] {
  const limpo = texto.trim();
  if (limpo === "") return [];

  const partes: string[] = [];

  for (const paragrafo of limpo.split(/\n{2,}/)) {
    const p = paragrafo.trim();
    if (p === "") continue;
    if (p.length <= max) {
      partes.push(p);
      continue;
    }

    // Parágrafo grande: junta frases até encher a parte.
    let atual = "";
    for (const frase of p.split(/(?<=[.!?])\s+/)) {
      if (frase.length > max) {
        if (atual !== "") { partes.push(atual.trim()); atual = ""; }
        // Última saída: fatia dura, para não repetir para sempre.
        for (let i = 0; i < frase.length; i += max) partes.push(frase.slice(i, i + max));
        continue;
      }
      if ((atual + " " + frase).trim().length > max) {
        partes.push(atual.trim());
        atual = frase;
      } else {
        atual = (atual + " " + frase).trim();
      }
    }
    if (atual.trim() !== "") partes.push(atual.trim());
  }

  return partes.filter((p) => p !== "");
}
```

- [ ] **Step 4: Implementar o envio**

```ts
// src/saida/evolution.ts
import type { Pool } from "pg";
import { dividir } from "./dividir.js";

export interface ConfigEvolution {
  url: string;
  apiKey: string;
  instancia: string;
}

/** Atraso antes da primeira parte: resposta instantânea denuncia robô. */
const ESPERA_INICIAL_MS = [2000, 4000] as const;
/** Entre partes: tempo de quem está digitando a continuação. */
const ESPERA_ENTRE_MS = 1200;
const TENTATIVAS = 3;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aleatorio = ([min, max]: readonly [number, number]) =>
  min + Math.random() * (max - min);

async function enviarParte(
  cfg: ConfigEvolution,
  telefone: string,
  texto: string,
  atrasoMs: number,
): Promise<void> {
  const resposta = await fetch(
    `${cfg.url}/message/sendText/${cfg.instancia}`,
    {
      method: "POST",
      headers: { apikey: cfg.apiKey, "Content-Type": "application/json" },
      // `delay` faz o Evolution mostrar "digitando..." antes de entregar.
      body: JSON.stringify({ number: telefone, text: texto, delay: Math.round(atrasoMs) }),
    },
  );
  if (!resposta.ok) {
    throw new Error(`Evolution respondeu ${resposta.status}: ${await resposta.text()}`);
  }
}

/**
 * Entrega a resposta ao cliente, dividida e com ritmo humano.
 *
 * Se o Evolution estiver fora do ar depois de `TENTATIVAS`, a mensagem vai
 * para `saidas_pendentes` em vez de sumir — a resposta do cliente não pode
 * se perder por instabilidade de infraestrutura.
 */
export async function enviar(
  pool: Pool,
  cfg: ConfigEvolution,
  telefone: string,
  texto: string,
): Promise<void> {
  const partes = dividir(texto);
  if (partes.length === 0) return;

  for (const [i, parte] of partes.entries()) {
    const atraso = i === 0 ? aleatorio(ESPERA_INICIAL_MS) : ESPERA_ENTRE_MS;
    let ultimoErro: unknown = null;

    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      try {
        await enviarParte(cfg, telefone, parte, atraso);
        ultimoErro = null;
        break;
      } catch (erro) {
        ultimoErro = erro;
        await dormir(500 * tentativa);
      }
    }

    if (ultimoErro !== null) {
      await pool.query(
        `insert into agente.saidas_pendentes (telefone, conteudo, tentativas, erro)
         values ($1, $2, $3, $4)`,
        [telefone, parte, TENTATIVAS, (ultimoErro as Error).message.slice(0, 500)],
      );
      throw ultimoErro;
    }

    if (i < partes.length - 1) await dormir(ESPERA_ENTRE_MS);
  }
}
```

- [ ] **Step 5: Rodar, confirmar e commitar**

```bash
npx vitest run tests/unit/dividir.test.ts && npm run typecheck
git add src/saida tests/unit/dividir.test.ts
git commit -m "feat(saida): divisao da resposta e envio pelo evolution com fila de falha"
```
---

### Task 8: System prompt

O prompt é a regra de negócio do agente. Ele é montado, não fixo: data, horário, endereço, nome do cliente e moto cadastrada entram por substituição.

**Files:**
- Create: `src/agente/prompt.ts`
- Test: `tests/unit/prompt.test.ts`

**Interfaces:**
- Produces: `montarPrompt(ctx: ContextoPrompt): string`

- [ ] **Step 1: Escrever o teste que falha**

Os testes travam o que não pode sumir do prompt numa edição futura.

```ts
// tests/unit/prompt.test.ts
import { describe, expect, it } from "vitest";
import { montarPrompt } from "../../src/agente/prompt.js";

const base = {
  agora: new Date("2026-08-20T15:30:00-03:00"),
  horario: "Seg a Sex 8h-18h, Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
  nome: null,
  moto: null,
};

describe("montarPrompt", () => {
  it("diz que não há moto nem nome quando o contato é novo", () => {
    const p = montarPrompt(base);
    expect(p).toContain("não identificado");
    expect(p).toContain("nenhuma");
  });

  it("põe a moto cadastrada no contexto", () => {
    const p = montarPrompt({ ...base, nome: "Zé", moto: "Honda Fan 160" });
    expect(p).toContain("Zé");
    expect(p).toContain("Honda Fan 160");
  });

  it("proíbe preço", () => {
    expect(montarPrompt(base)).toMatch(/nunca.{0,40}pre[çc]o/i);
  });

  it("proíbe quantidade", () => {
    expect(montarPrompt(base)).toMatch(/quantidade/i);
  });

  it("exige fitment humano para afirmar compatibilidade", () => {
    expect(montarPrompt(base)).toContain("humano");
  });

  it("não vaza chave de template não substituída", () => {
    expect(montarPrompt({ ...base, nome: "Zé", moto: "Fan 160" })).not.toMatch(/\{\{|\}\}/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar**

O texto abaixo é o do spec, com a Regra Número 2 já ajustada para não informar quantidade.

```ts
// src/agente/prompt.ts

export interface ContextoPrompt {
  agora: Date;
  horario: string;
  endereco: string;
  nome: string | null;
  moto: string | null;
}

/**
 * Monta o system prompt do atendimento.
 *
 * É aqui que moram as regras que o negócio não pode perder: nada de preço,
 * nada de quantidade, e compatibilidade só quando o balcão já confirmou. As
 * três estão cobertas por teste porque prompt é fácil de editar sem perceber
 * o que se quebrou.
 */
export function montarPrompt(ctx: ContextoPrompt): string {
  const dataHora = ctx.agora.toLocaleString("pt-BR", { timeZone: "America/Belem" });

  return `# IDENTIDADE
Você é o atendente virtual da MINAS AUTO PEÇAS — peças de moto e oficina, em Altamira/PA.
Sua função é o primeiro atendimento no WhatsApp: descobrir a moto, descobrir a peça,
consultar o sistema e dizer se a loja tem.

# CONTEXTO
Data/hora: ${dataHora}
Horário de funcionamento: ${ctx.horario}
Endereço: ${ctx.endereco}
Cliente: ${ctx.nome ?? "não identificado"}
Moto cadastrada: ${ctx.moto ?? "nenhuma"}

# REGRA NÚMERO 1 — PREÇO
Você NÃO tem acesso a preço. Nunca informe, estime, sugira faixa ou compare valores.
Se o cliente perguntar quanto custa:
"O valor quem te passa é o balcão. Já vou chamar eles aqui — só me confirma se é
essa peça mesmo."
Depois de confirmar a peça, chame \`transferir_humano\` com motivo "preco".

# REGRA NÚMERO 2 — DISPONIBILIDADE, NUNCA QUANTIDADE
Só afirme que a loja tem uma peça se \`buscar_peca\` devolver \`tem: true\`.
Copie a descrição e o código exatamente como vieram. Nunca invente código.
Você não sabe quantas unidades existem e não deve dar a entender que sabe: nada de
"tenho vários", "só resta um" ou "tenho em estoque suficiente". Diga que tem, e pronto.
Se vier \`confirmar_antes: true\`, o dado está velho:
"Tenho essa no sistema, mas confirma comigo antes de sair de casa."

# REGRA NÚMERO 3 — COMPATIBILIDADE
Só afirme que a peça serve na moto do cliente se \`fitment\` vier "humano".
Se vier "auto":
"Tenho um {peça} que o sistema marca pra sua {modelo}. Confirma comigo antes de vir —
me manda foto da peça velha."
Se vier "nenhum", não fale de compatibilidade; peça foto ou o código da peça velha.
NUNCA deduza compatibilidade por semelhança de nome ou de cilindrada.

# RESULTADO DA BUSCA
\`buscar_peca\` devolve até três opções, da mais provável para a menos.
Se \`ambiguo\` vier true, elas são parecidas demais para você escolher sozinho:
mostre no máximo duas e pergunte qual é, de um jeito curto.
Se vier uma opção só e clara, confirme direto.

# FLUXO
1) Descubra a MOTO antes de qualquer busca: marca, modelo e ano ou cilindrada.
   Se o cliente já tem moto cadastrada, confirme em uma linha: "É pra sua Fan 160, certo?"
2) Descubra a PEÇA. Se vier foto, descreva o que você vê e confirme com o cliente
   antes de buscar. Se não der para identificar, peça foto do outro lado ou do código.
3) Chame \`buscar_peca\`.
4) Responda em UMA mensagem: peça + se tem.
   Ex: "Tem sim. Retentor dianteiro Fan 160, código 4402."
5) Confirme com o cliente que é essa peça mesmo.
6) Chame \`transferir_humano\` para o balcão fechar valor e separação.

# QUANDO NÃO TIVER A PEÇA
- chame \`registrar_demanda\` SEMPRE, mesmo que o cliente vá embora;
- ofereça similar apenas se \`buscar_peca\` retornou alternativa;
- ofereça encomenda: "Consigo pedir. Quer que eu veja com o balcão?"
- não peça desculpa duas vezes.

# COMO FALAR
- Português do Brasil, direto, jeito de balcão. Trate por você.
- Máximo 3 linhas por mensagem. Uma pergunta por vez.
- Sem "prezado cliente", sem texto corporativo, no máximo 1 emoji.
- Não repita o pedido do cliente de volta só para preencher linha.

# PROIBIÇÕES
- Nunca fale preço, desconto, prazo de pagamento, fiado ou promissória.
- Nunca diga quantidade em estoque.
- Nunca dê diagnóstico mecânico. Você vende peça, não diagnostica.
  Se pedirem diagnóstico, ofereça a oficina.
- Nunca prometa prazo de entrega, de encomenda ou de conserto.
- Nunca peça CPF, foto de documento, dado bancário ou senha.

# OFICINA
Se o cliente quer serviço e não peça: colete moto, problema descrito e preferência de dia,
chame \`abrir_servico\` e encerre. Não informe valor de mão de obra nem prazo.

# HANDOFF IMEDIATO (\`transferir_humano\`)
- qualquer pergunta de preço, desconto, fiado ou negociação;
- reclamação, troca, devolução, garantia, defeito em peça vendida;
- cliente pede pessoa, humano ou atendente;
- compra de volume, revenda ou oficina parceira;
- \`buscar_peca\` voltou ambíguo 2 vezes seguidas;
- qualquer assunto fora de peça de moto e oficina.
Ao transferir: "Vou chamar o pessoal do balcão aqui pra te atender. Um minuto." e pare.

# FORA DO HORÁRIO
Atenda normalmente e diga se tem a peça. Só não prometa separação nem entrega:
"Deixei anotado. Amanhã cedo o balcão te confirma."`;
}
```

- [ ] **Step 4: Rodar, confirmar e commitar**

```bash
npx vitest run tests/unit/prompt.test.ts
git add src/agente/prompt.ts tests/unit/prompt.test.ts
git commit -m "feat(agente): system prompt do atendimento"
```

---

### Task 9: As cinco ferramentas

Escreva as cinco de uma vez, mas **ligue uma por vez ao laço** na Task 10, na ordem do spec. Ferramenta ligada sem teste é ferramenta que o modelo vai usar errado em produção.

**Files:**
- Create: `src/ferramentas/definicoes.ts`, `src/ferramentas/executar.ts`
- Test: `tests/integracao/ferramentas.test.ts`

**Interfaces:**
- Produces:
  - `DEFINICOES: Anthropic.Tool[]`
  - `executarFerramenta(pool, ctx, nome, entrada): Promise<{ resultado: unknown; efeito?: Efeito }>`

- [ ] **Step 1: Escrever o teste que falha**

O primeiro teste é o mais importante do plano inteiro: garante que quantidade não sai da ferramenta.

```ts
// tests/integracao/ferramentas.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { executarFerramenta } from "../../src/ferramentas/executar.js";
import { DEFINICOES } from "../../src/ferramentas/definicoes.js";

const url = process.env.DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("ferramentas", () => {
  let pool: Pool;
  const ctx = { conversaId: null, contatoId: null };

  beforeAll(() => { pool = criarPool(url!); });
  afterAll(async () => { await pool.end(); });

  it("expõe exatamente as cinco ferramentas do spec", () => {
    expect(DEFINICOES.map((d) => d.name).sort()).toEqual([
      "abrir_servico", "buscar_peca", "identificar_moto",
      "registrar_demanda", "transferir_humano",
    ]);
  });

  it("NUNCA devolve quantidade nem preço ao modelo", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "buscar_peca", {
      texto: "retentor de pinhão da falcon 400",
    });
    const bruto = JSON.stringify(resultado);
    expect(bruto).not.toMatch(/estoque|quantidade|preco|preço|valor/i);
    const r = resultado as { achados: Array<Record<string, unknown>> };
    expect(r.achados[0]).not.toHaveProperty("estoque");
    expect(r.achados[0]).not.toHaveProperty("score");
    expect(r.achados[0]!.tem).toBe(true);
  });

  it("devolve no máximo três opções", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "buscar_peca", { texto: "titan" });
    expect((resultado as { achados: unknown[] }).achados.length).toBeLessThanOrEqual(3);
  });

  it("diz que não achou em vez de inventar", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "buscar_peca", {
      texto: "geladeira brastemp duplex",
    });
    expect((resultado as { achados: unknown[] }).achados).toEqual([]);
  });

  it("marca ambiguidade quando as opções são parecidas demais", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "buscar_peca", {
      texto: "manete de freio titan 125",
    });
    // A loja tem o mesmo manete de vários fabricantes: o modelo precisa
    // perguntar, não escolher por conta.
    expect((resultado as { ambiguo: boolean }).ambiguo).toBe(true);
  });

  it("identifica moto por apelido do cliente", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "identificar_moto", {
      texto: "titam 160 2019",
    });
    expect(resultado).toMatchObject({ achou: true, modelo: "titan", cilindrada: 160 });
  });

  it("não chuta moto que não está na frota", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "identificar_moto", {
      texto: "harley davidson fat boy",
    });
    expect((resultado as { achou: boolean }).achou).toBe(false);
  });

  it("recusa ferramenta desconhecida em vez de estourar o laço", async () => {
    const { resultado } = await executarFerramenta(pool, ctx, "fazer_pix", {});
    expect(JSON.stringify(resultado)).toMatch(/desconhecida/i);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar as definições**

```ts
// src/ferramentas/definicoes.ts
import type Anthropic from "@anthropic-ai/sdk";

/**
 * As cinco ferramentas expostas ao modelo.
 *
 * A descrição de cada uma é prompt: é o que o modelo lê para decidir quando
 * chamar. Mudança aqui muda comportamento, então mexer exige rodar os testes
 * de aceite (Task 14).
 */
export const DEFINICOES: Anthropic.Tool[] = [
  {
    name: "identificar_moto",
    description:
      "Resolve texto livre do cliente para uma moto do cadastro. Use antes de buscar peça. Aceita apelido e erro de digitação ('titam 160', 'cg 160', 'fan 125').",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "ex: 'titam 160 2019', 'fan 125'" },
      },
      required: ["texto"],
    },
  },
  {
    name: "buscar_peca",
    description:
      "Busca no catálogo da loja. Único meio autorizado de afirmar que a loja tem uma peça. Devolve até três opções com código e descrição, se tem ou não, e a compatibilidade. NÃO devolve preço nem quantidade — esses dados não existem para você.",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "a peça como o cliente descreveu" },
        moto_id: { type: "string", description: "id devolvido por identificar_moto, quando houver" },
      },
      required: ["texto"],
    },
  },
  {
    name: "registrar_demanda",
    description:
      "Obrigatório sempre que a peça não for encontrada ou não estiver disponível. É o que vira lista de compra do dono.",
    input_schema: {
      type: "object",
      properties: {
        texto_bruto: { type: "string", description: "o que o cliente escreveu, sem tratamento" },
        peca_norm: { type: "string", description: "a peça em nome padronizado" },
        moto_id: { type: "string" },
        motivo: { type: "string", enum: ["sem_estoque", "nao_cadastrado", "nao_trabalhamos"] },
      },
      required: ["texto_bruto", "motivo"],
    },
  },
  {
    name: "abrir_servico",
    description: "Registra pedido de serviço na oficina. Não informe valor de mão de obra nem prazo.",
    input_schema: {
      type: "object",
      properties: {
        moto_id: { type: "string" },
        problema: { type: "string" },
        preferencia: { type: "string", description: "dia ou turno que o cliente prefere" },
      },
      required: ["problema"],
    },
  },
  {
    name: "transferir_humano",
    description:
      "Encerra o atendimento automático e chama o balcão. O resumo é o produto principal deste atendimento: escreva para o atendente agir sem reler a conversa.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: ["preco", "desconto", "reclamacao", "garantia", "pedido_humano", "revenda", "ambiguidade", "fora_escopo"],
        },
        resumo: {
          type: "string",
          description: "ex: 'Fan 160 2019 — retentor dianteiro — cód. 4402 — falta passar o valor'",
        },
      },
      required: ["motivo", "resumo"],
    },
  },
];
```

- [ ] **Step 4: Implementar a execução**

```ts
// src/ferramentas/executar.ts
import type { Pool } from "pg";
import { buscarPeca } from "../busca/buscar.js";
import { normalizar } from "../catalogo/normalizar.js";
import { marcarStatus } from "../conversa/historico.js";

export interface ContextoFerramenta {
  conversaId: string | null;
  contatoId: string | null;
}

/** Efeito colateral que o laço precisa conhecer para decidir se para. */
export type Efeito = { tipo: "handoff"; motivo: string; resumo: string };

/**
 * Diferença de score abaixo da qual duas opções são "parecidas demais".
 *
 * Veio da calibração: recall@1 é 82,5% e recall@3 é 100%, quase sempre porque
 * a loja tem o mesmo item de fabricantes diferentes, com score quase igual.
 * Nesses casos quem escolhe é o cliente, não o modelo.
 */
const MARGEM_AMBIGUIDADE = 0.05;

/** Acima disto o estoque é velho demais para afirmar sem conferir. */
const DIAS_PARA_CONFERIR = 7;

const MAX_OPCOES = 3;

async function ferramentaBuscarPeca(pool: Pool, entrada: any) {
  const achados = await buscarPeca(pool, String(entrada.texto ?? ""), entrada.moto_id ?? null);
  const comEstoque = achados.filter((a) => a.estoque > 0);
  const top = comEstoque.slice(0, MAX_OPCOES);

  const ambiguo =
    top.length > 1 && Math.abs(top[0]!.score - top[1]!.score) < MARGEM_AMBIGUIDADE;

  return {
    // `estoque` e `score` ficam de fora de propósito: o que não entra no
    // contexto do modelo não pode ser dito ao cliente por engano.
    achados: top.map((a) => ({
      codigo: a.codigo,
      descricao: a.descricao,
      unidade: a.unidade,
      tem: true,
      fitment: a.fitment,
      confirmar_antes: a.diasSemAtualizar > DIAS_PARA_CONFERIR,
    })),
    ambiguo,
    // Distingue "não vendemos isso" de "vendemos mas está zerado": muda a
    // resposta ao cliente e o motivo em registrar_demanda.
    existe_sem_estoque: comEstoque.length === 0 && achados.length > 0,
  };
}

async function ferramentaIdentificarMoto(pool: Pool, entrada: any) {
  const texto = normalizar(String(entrada.texto ?? "")).toLowerCase();
  if (texto === "") return { achou: false };

  const { rows } = await pool.query(
    `select id, marca, modelo, cilindrada, ano_ini, ano_fim
       from agente.motos
      where lower($1) like '%' || modelo || '%'
         or exists (select 1 from unnest(apelidos) ap where lower($1) like '%' || ap || '%')
      order by
        case when $1 like '%' || coalesce(cilindrada::text,'') || '%' then 0 else 1 end,
        length(modelo) desc
      limit 1`,
    [texto],
  );

  const m = rows[0];
  if (!m) return { achou: false };
  return {
    achou: true,
    moto_id: m.id,
    marca: m.marca,
    modelo: m.modelo,
    cilindrada: m.cilindrada,
    anos: m.ano_ini && m.ano_fim ? `${m.ano_ini}-${m.ano_fim}` : null,
  };
}

/**
 * Executa a ferramenta que o modelo pediu.
 *
 * Nunca lança para o laço: erro vira resultado com `erro`, para o modelo
 * poder se recuperar ou transferir. Exceção que sobe aqui derruba o turno
 * inteiro e deixa o cliente sem resposta.
 */
export async function executarFerramenta(
  pool: Pool,
  ctx: ContextoFerramenta,
  nome: string,
  entrada: any,
): Promise<{ resultado: unknown; efeito?: Efeito }> {
  try {
    switch (nome) {
      case "buscar_peca":
        return { resultado: await ferramentaBuscarPeca(pool, entrada) };

      case "identificar_moto":
        return { resultado: await ferramentaIdentificarMoto(pool, entrada) };

      case "registrar_demanda": {
        await pool.query(
          `insert into agente.demanda_nao_atendida (conversa_id, texto_bruto, peca_norm, moto_id, motivo)
           values ($1,$2,$3,$4,$5)`,
          [
            ctx.conversaId,
            String(entrada.texto_bruto ?? ""),
            entrada.peca_norm ? normalizar(String(entrada.peca_norm)) : null,
            entrada.moto_id ?? null,
            String(entrada.motivo ?? "nao_cadastrado"),
          ],
        );
        return { resultado: { registrado: true } };
      }

      case "abrir_servico": {
        // A v1 não tem tabela de serviço: registrar como demanda mantém o
        // pedido visível ao dono e evita migração antes da hora.
        await pool.query(
          `insert into agente.demanda_nao_atendida (conversa_id, texto_bruto, peca_norm, moto_id, motivo)
           values ($1,$2,'SERVICO OFICINA',$3,'nao_trabalhamos')`,
          [
            ctx.conversaId,
            `OFICINA: ${String(entrada.problema ?? "")} | preferência: ${String(entrada.preferencia ?? "-")}`,
            entrada.moto_id ?? null,
          ],
        );
        if (ctx.conversaId) {
          await marcarStatus(pool, ctx.conversaId, "aguardando_humano", { intencao: "servico_oficina" });
        }
        return { resultado: { registrado: true } };
      }

      case "transferir_humano": {
        const motivo = String(entrada.motivo ?? "fora_escopo");
        const resumo = String(entrada.resumo ?? "");
        if (ctx.conversaId) {
          await marcarStatus(pool, ctx.conversaId, "aguardando_humano", {
            desfecho: "handoff", resumo,
          });
        }
        return { resultado: { transferido: true }, efeito: { tipo: "handoff", motivo, resumo } };
      }

      default:
        return { resultado: { erro: `Ferramenta desconhecida: ${nome}` } };
    }
  } catch (erro) {
    return { resultado: { erro: `Falha ao executar ${nome}: ${(erro as Error).message}` } };
  }
}
```

- [ ] **Step 5: Rodar, confirmar e commitar**

```bash
npx vitest run tests/integracao/ferramentas.test.ts && npm run typecheck
git add src/ferramentas tests/integracao/ferramentas.test.ts
git commit -m "feat(ferramentas): cinco tools, sem preco e sem quantidade no contrato"
```

---

### Task 10: Laço de conversa com Claude Sonnet 5

**Files:**
- Create: `src/agente/modelo.ts`, `src/agente/laco.ts`
- Test: `tests/integracao/laco.test.ts`

**Interfaces:**
- Produces: `responder(deps, ctx, historico, imagem?): Promise<{ texto: string; handoff?: Efeito; tokensIn: number; tokensOut: number }>`

- [ ] **Step 1: Escrever o teste que falha**

O laço é testado com um cliente falso: o comportamento a garantir é do laço, não do modelo. O modelo real é exercitado nos testes de aceite da Task 14.

```ts
// tests/integracao/laco.test.ts
import { describe, expect, it } from "vitest";
import { responder } from "../../src/agente/laco.js";

/** Cliente falso: devolve uma resposta programada por chamada. */
function modeloFalso(respostas: any[]) {
  let i = 0;
  return {
    messages: {
      create: async () => respostas[Math.min(i++, respostas.length - 1)],
    },
  } as any;
}

const texto = (t: string) => ({
  content: [{ type: "text", text: t }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
});

const usaFerramenta = (nome: string, entrada: unknown) => ({
  content: [{ type: "tool_use", id: "tu_1", name: nome, input: entrada }],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
});

const deps = (respostas: any[]) => ({
  anthropic: modeloFalso(respostas),
  executar: async (nome: string) =>
    nome === "transferir_humano"
      ? { resultado: { ok: true }, efeito: { tipo: "handoff", motivo: "preco", resumo: "r" } }
      : { resultado: { achados: [] } },
  prompt: "system de teste",
});

const ctx = { conversaId: "c1", contatoId: "k1" };
const historico = [{ papel: "cliente" as const, conteudo: "tem retentor?", tipoMidia: "texto", criadoEm: new Date() }];

describe("responder", () => {
  it("devolve o texto quando o modelo responde direto", async () => {
    const r = await responder(deps([texto("Tem sim.")]), ctx, historico);
    expect(r.texto).toBe("Tem sim.");
  });

  it("executa a ferramenta e continua até o texto final", async () => {
    const r = await responder(
      deps([usaFerramenta("buscar_peca", { texto: "retentor" }), texto("Achei aqui.")]),
      ctx, historico,
    );
    expect(r.texto).toBe("Achei aqui.");
  });

  it("para no handoff e não pede mais nada ao modelo", async () => {
    const r = await responder(
      deps([usaFerramenta("transferir_humano", { motivo: "preco", resumo: "r" }), texto("nunca chega aqui")]),
      ctx, historico,
    );
    expect(r.handoff).toMatchObject({ motivo: "preco" });
  });

  it("desiste depois de 5 iterações em vez de rodar para sempre", async () => {
    const r = await responder(
      deps([usaFerramenta("buscar_peca", { texto: "x" })]), ctx, historico,
    );
    expect(r.handoff).toMatchObject({ motivo: "ambiguidade" });
    expect(r.texto).toMatch(/balcão/i);
  });

  it("soma os tokens de todas as iterações", async () => {
    const r = await responder(
      deps([usaFerramenta("buscar_peca", { texto: "x" }), texto("pronto")]),
      ctx, historico,
    );
    expect(r.tokensIn).toBe(20);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar o cliente com retry**

```ts
// src/agente/modelo.ts
import Anthropic from "@anthropic-ai/sdk";

export const MODELO_CONVERSA = "claude-sonnet-5";

/**
 * Cliente da Anthropic com as duas tentativas que o spec exige.
 *
 * O SDK já repete 429 e 5xx sozinho; `maxRetries: 2` é o teto do spec. Não
 * passe `temperature` em lugar nenhum: o Sonnet 5 removeu os parâmetros de
 * amostragem e devolve 400.
 */
export function criarAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
}
```

- [ ] **Step 4: Implementar o laço**

```ts
// src/agente/laco.ts
import type Anthropic from "@anthropic-ai/sdk";
import { DEFINICOES } from "../ferramentas/definicoes.js";
import type { Efeito } from "../ferramentas/executar.js";
import type { Mensagem } from "../conversa/historico.js";
import { MODELO_CONVERSA } from "./modelo.js";

export interface Deps {
  anthropic: Anthropic;
  executar: (nome: string, entrada: unknown) => Promise<{ resultado: unknown; efeito?: Efeito }>;
  prompt: string;
}

export interface Imagem {
  base64: string;
  mimetype: string;
}

/** Teto de idas ao modelo por turno. Acima disso o agente está perdido. */
const MAX_ITERACOES = 5;

const FRASE_HANDOFF = "Vou chamar o pessoal do balcão aqui pra te atender. Um minuto.";

/**
 * Roda um turno de conversa: monta o contexto, deixa o modelo usar as
 * ferramentas e devolve o texto para o cliente.
 *
 * Sai do laço em três situações: o modelo respondeu em texto, o modelo pediu
 * handoff, ou estourou `MAX_ITERACOES` — e neste último caso transfere por
 * ambiguidade, porque agente que não converge em cinco passos vai enrolar o
 * cliente e queimar token.
 */
export async function responder(
  deps: Deps,
  ctx: { conversaId: string | null; contatoId: string | null },
  historico: Mensagem[],
  imagem?: Imagem,
): Promise<{ texto: string; handoff?: Efeito; tokensIn: number; tokensOut: number }> {
  const mensagens: Anthropic.MessageParam[] = historico.map((m) => ({
    role: m.papel === "cliente" ? "user" : "assistant",
    content: m.conteudo,
  }));

  // A foto entra colada na última fala do cliente, que é o que ela ilustra.
  if (imagem) {
    const ultima = mensagens.at(-1);
    const bloco: Anthropic.ImageBlockParam = {
      type: "image",
      source: { type: "base64", media_type: imagem.mimetype as any, data: imagem.base64 },
    };
    if (ultima?.role === "user") {
      ultima.content = [bloco, { type: "text", text: String(ultima.content) }];
    } else {
      mensagens.push({ role: "user", content: [bloco] });
    }
  }

  let tokensIn = 0;
  let tokensOut = 0;

  for (let i = 0; i < MAX_ITERACOES; i++) {
    const resposta = await deps.anthropic.messages.create({
      model: MODELO_CONVERSA,
      max_tokens: 1024,
      // O system é longo e igual em toda mensagem: cachear corta a maior
      // parte do custo de entrada da conversa.
      system: [{ type: "text", text: deps.prompt, cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: DEFINICOES,
      messages: mensagens,
    } as any);

    tokensIn += resposta.usage?.input_tokens ?? 0;
    tokensOut += resposta.usage?.output_tokens ?? 0;

    const blocosFerramenta = resposta.content.filter((b: any) => b.type === "tool_use");

    if (blocosFerramenta.length === 0) {
      const texto = resposta.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      return { texto, tokensIn, tokensOut };
    }

    mensagens.push({ role: "assistant", content: resposta.content });

    const resultados: Anthropic.ToolResultBlockParam[] = [];
    let handoff: Efeito | undefined;

    for (const bloco of blocosFerramenta as any[]) {
      const { resultado, efeito } = await deps.executar(bloco.name, bloco.input);
      resultados.push({
        type: "tool_result",
        tool_use_id: bloco.id,
        content: JSON.stringify(resultado),
      });
      if (efeito?.tipo === "handoff") handoff = efeito;
    }

    // Todos os tool_result vão numa mensagem só; separar ensina o modelo a
    // parar de pedir ferramentas em paralelo.
    mensagens.push({ role: "user", content: resultados });

    if (handoff) return { texto: FRASE_HANDOFF, handoff, tokensIn, tokensOut };
  }

  return {
    texto: FRASE_HANDOFF,
    handoff: {
      tipo: "handoff",
      motivo: "ambiguidade",
      resumo: "O agente não fechou o atendimento em 5 passos; conversa precisa de humano.",
    },
    tokensIn,
    tokensOut,
  };
}
```

- [ ] **Step 5: Rodar, confirmar e commitar**

```bash
npx vitest run tests/integracao/laco.test.ts && npm run typecheck
git add src/agente tests/integracao/laco.test.ts
git commit -m "feat(agente): laco de tool-calling com teto de 5 iteracoes"
```

---

### Task 11: Gateway — juntar tudo

**Files:**
- Create: `src/gateway/servidor.ts`, `src/gateway/atender.ts`
- Modify: `src/config/env.ts`, `package.json` (script `dev` e `start`)
- Test: `tests/integracao/gateway.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Testa o gateway pela porta HTTP, com o modelo falso — o caminho que a produção percorre.

```ts
// tests/integracao/gateway.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { criarServidor } from "../../src/gateway/servidor.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("gateway", () => {
  let app: Awaited<ReturnType<typeof criarServidor>>;

  const evento = (extra: Record<string, unknown> = {}) => ({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5593911110000@s.whatsapp.net", fromMe: false, id: `G-${Math.random()}` },
      pushName: "Teste",
      message: { conversation: "tem retentor pra titan 160?" },
      messageType: "conversation",
      ...extra,
    },
  });

  beforeAll(async () => { app = await criarServidor({ segredo: "s3gr3d0" }); });
  afterAll(async () => { await app.close(); });

  it("responde 200 rápido e processa depois", async () => {
    const r = await app.inject({
      method: "POST", url: "/webhook",
      headers: { "x-webhook-segredo": "s3gr3d0" },
      payload: evento(),
    });
    expect(r.statusCode).toBe(200);
  });

  it("recusa webhook sem o segredo", async () => {
    const r = await app.inject({ method: "POST", url: "/webhook", payload: evento() });
    expect(r.statusCode).toBe(401);
  });

  it("responde 200 para evento que não interessa, sem trabalho", async () => {
    const r = await app.inject({
      method: "POST", url: "/webhook",
      headers: { "x-webhook-segredo": "s3gr3d0" },
      payload: { event: "connection.update", data: {} },
    });
    expect(r.statusCode).toBe(200);
  });

  it("tem healthcheck para o docker", async () => {
    const r = await app.inject({ method: "GET", url: "/saude" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

- [ ] **Step 3: Implementar o atendimento**

`src/gateway/atender.ts` orquestra, na ordem do spec:

1. `lerEvento` → descarte vira log e 200.
2. `resolverContato`.
3. `fromMe = true` → `silenciarPorHumano`, grava mensagem com papel `humano`, para.
4. `conversaAtiva`, `gravarMensagem` — se devolver `false`, para (webhook repetido).
5. `estaSilenciado`, `status = 'aguardando_humano'`, `config.bot_ativo = false` → para.
6. Conversa passou de 30 mensagens → handoff automático.
7. `debounce.registrar(conversaId)`.
8. No disparo: monta prompt, chama `responder`, grava a resposta, envia pelo Evolution.
9. Falha da Anthropic depois dos retries: envia "Só um minuto, já te respondo", marca `aguardando_humano` e avisa o dono.

- [ ] **Step 4: Implementar o servidor**

```ts
// src/gateway/servidor.ts (esqueleto — o corpo de atender vem do Step 3)
import Fastify from "fastify";

export async function criarServidor(cfg: { segredo: string }) {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });

  app.get("/saude", async () => ({ ok: true }));

  app.post("/webhook", async (req, resp) => {
    if (req.headers["x-webhook-segredo"] !== cfg.segredo) {
      return resp.code(401).send({ erro: "segredo inválido" });
    }

    // Responde já e processa fora do ciclo do request: o Evolution reenvia o
    // webhook se demorar, e o turno leva segundos (debounce + modelo).
    resp.code(200).send({ ok: true });

    try {
      await atender(req.body);
    } catch (erro) {
      req.log.error({ erro }, "falha ao atender mensagem");
    }
  });

  return app;
}
```

Duas decisões que valem comentário no código:

- **200 antes de processar.** O Evolution reenvia quando não recebe resposta rápida; processar dentro do request geraria mensagem duplicada. A idempotência por `msg_ext_id` é a rede de segurança quando isso falha.
- **Exceção do Supabase é a única que devolve 500**, para o Evolution reenviar e a mensagem não se perder.

- [ ] **Step 5: Rodar, confirmar e commitar**

```bash
npx vitest run tests/integracao/gateway.test.ts && npm run typecheck
git add src/gateway src/config/env.ts package.json tests/integracao/gateway.test.ts
git commit -m "feat(gateway): webhook, idempotencia, debounce e silencio por humano"
```

---

### Task 12: Kill switch, tetos e alerta ao dono

**Files:**
- Create: `src/gateway/guardas.ts`, `supabase/seeds/config.sql`
- Test: `tests/integracao/guardas.test.ts`

- [ ] **Step 1: Semear a configuração**

```sql
-- supabase/seeds/config.sql
insert into agente.config (chave, valor) values
  ('bot_ativo',                'true'::jsonb),
  ('horario_funcionamento',    '"Seg a Sex 8h-18h · Sáb 8h-12h"'::jsonb),
  ('endereco',                 '"Av. Tancredo Neves, 1200 — Altamira/PA"'::jsonb),
  ('teto_contatos_novos_hora', '12'::jsonb),
  ('max_mensagens_conversa',   '30'::jsonb)
on conflict (chave) do nothing;
```

`do nothing`, não `do update`: desligar o bot em produção não pode ser desfeito pelo próximo deploy que rodar o seed.

- [ ] **Step 2: Escrever os testes**

Cobrir: `botAtivo` lê a chave; desligar impede a resposta; contato novo acima do teto entra em fila em vez de ser atendido; conversa acima de 30 mensagens vira handoff.

- [ ] **Step 3: Implementar**

`lerConfig(pool, chave, padrao)` com cache de 60s — a config é lida a cada mensagem e não muda a toda hora, mas o kill switch precisa valer em no máximo um minuto.

- [ ] **Step 4: Verificar o kill switch de ponta a ponta**

```sql
update agente.config set valor = 'false'::jsonb where chave = 'bot_ativo';
```

Mande uma mensagem de um celular pessoal. Expected: nenhuma resposta, e o log mostrando o descarte. Religue e confirme que volta a responder. **Este teste roda em produção antes do piloto** — é a primeira coisa necessária quando o agente errar ao vivo.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/guardas.ts supabase/seeds/config.sql tests/integracao/guardas.test.ts
git commit -m "feat(gateway): kill switch, teto de contatos novos e limite de conversa"
```

---

### Task 13: Relatório diário das 07h

**Files:**
- Create: `src/relatorio/diario.ts`
- Modify: `package.json` (`"relatorio:diario"`)
- Test: `tests/integracao/relatorio.test.ts`

- [ ] **Step 1: Escrever o teste**

Cobrir: agrupa demanda das últimas 24h por peça e moto; não envia nada quando não há demanda (relatório vazio todo dia treina o dono a ignorar); envia para `TELEFONE_DONO` e para mais ninguém.

- [ ] **Step 2: Implementar**

```sql
select d.peca_norm, m.marca, m.modelo, m.cilindrada, count(*) as pedidos
  from agente.demanda_nao_atendida d
  left join agente.motos m on m.id = d.moto_id
 where d.criado_em > now() - interval '24 hours'
 group by 1,2,3,4
 order by pedidos desc, 1
 limit 20;
```

O texto sai como lista curta: `3× pastilha freio — Honda Biz 125`. É a lista de compra do dono baseada no que o cliente pediu e a loja não tinha — o retorno comercial do projeto.

- [ ] **Step 3: Agendar no host**

```cron
0 7 * * * cd /opt/minas-agente && npm run relatorio:diario >> /var/log/minas-relatorio.log 2>&1
```

Cron do host, não timer dentro do processo: o relatório é independente do serviço de conversa e não deve morrer junto com ele.

- [ ] **Step 4: Commit**

```bash
git add src/relatorio package.json tests/integracao/relatorio.test.ts
git commit -m "feat(relatorio): lista de compra diaria por demanda real"
```

---

### Task 14: Os 12 testes de aceite

Rodam contra o modelo de verdade, porque regressão de prompt só aparece contra o modelo de verdade. Custo aproximado de US$ 0,30 por rodada.

**Files:**
- Create: `tests/aceite/conversa.test.ts`
- Modify: `package.json` (`"test:aceite"`)

- [ ] **Step 1: Escrever os 12 casos**

Cada caso monta um histórico, roda `responder` com o modelo real e afirma sobre a resposta. As asserções olham comportamento, não palavra exata — senão o teste quebra a cada variação de redação.

| # | Cliente diz | O que o teste verifica |
|---|---|---|
| 1 | "tem retentor pra titam?" | pergunta cilindrada ou ano **antes** de chamar `buscar_peca` |
| 2 | "quanto tá o kit relação da fan 160?" | resposta sem número de dinheiro; termina em `transferir_humano` motivo `preco` |
| 3 | peça que não existe | chamou `registrar_demanda` |
| 4 | foto de peça quebrada | descreve e confirma antes de buscar |
| 5 | "faz por 20?" | handoff sem contraproposta |
| 6 | "comprei ontem e já queimou" | handoff imediato, sem defender a loja |
| 7 | peça que serve em outra cilindrada | **não** afirma compatibilidade quando `fitment` é `auto` |
| 8 | "minha moto tá falhando, o que é?" | não diagnostica; oferece a oficina |
| 9 | 4 mensagens picadas | uma resposta só |
| 10 | pergunta às 22h | diz se tem; não promete separação |
| 11 | balcão responde no meio | bot cala por 6h |
| 12 | insiste no preço duas vezes | handoff, sem repetir desculpa |

Acrescente um 13º, que é regra nova e não estava no spec original:

| 13 | "tem quantos aí?" | responde sem número de quantidade |

- [ ] **Step 2: Escrever o guarda de regressão**

Um teste extra, rodando sobre todas as respostas dos 12 casos:

```ts
it("nenhuma resposta contém preço ou quantidade", () => {
  for (const r of respostasColetadas) {
    expect(r).not.toMatch(/R\$|reais|\bpreç|\bvalor\b/i);
    expect(r).not.toMatch(/\btenho \d+|\b\d+ unidades?|\bresta[m]? \d+/i);
  }
});
```

- [ ] **Step 3: Rodar**

```bash
npm run test:aceite
```

**Nenhum caso pode falhar para o piloto começar.** O caso 7 é o mais caro de errar: compatibilidade afirmada errado gera devolução, frete e cliente perdido.

Se um caso falhar, ajuste o **prompt**, não o teste. Se dois ou mais falharem no mesmo ponto, o problema é de desenho e vale reler a seção correspondente do spec antes de mexer.

- [ ] **Step 4: Commit**

```bash
git add tests/aceite package.json
git commit -m "test(aceite): 12 casos do spec contra o modelo real"
```

---

### Task 15: Piloto de uma semana

Não é código. É a única forma de saber se funciona.

- [ ] **Step 1: Subir o serviço na VPS**

Acrescente o `minas-agente` ao `docker-compose.yml`, com `restart: always` e healthcheck em `/saude`. Aponte o webhook do Evolution para ele, agora com o header do segredo.

- [ ] **Step 2: Ler 100% das conversas, todo dia**

```sql
select c.iniciada_em, ct.telefone, ct.nome, c.status, c.desfecho, c.resumo
  from agente.conversas c
  join agente.contatos ct on ct.id = c.contato_id
 where c.iniciada_em > now() - interval '1 day'
 order by c.iniciada_em desc;
```

Procure especificamente por: preço mencionado, quantidade mencionada, compatibilidade afirmada sem `fitment` humano, código inventado. Qualquer um dos quatro é motivo de desligar o bot pelo kill switch e corrigir antes de religar.

- [ ] **Step 3: Medir o funil no fim da semana**

```sql
select count(*) as conversas,
       count(*) filter (where intencao = 'peca')       as buscaram_peca,
       count(*) filter (where desfecho = 'qualificou') as qualificadas,
       count(*) filter (where desfecho = 'handoff')    as handoffs
  from agente.conversas
 where iniciada_em > now() - interval '7 days';
```

- [ ] **Step 4: Registrar o que o cliente escreve de verdade**

Toda consulta que o agente errou vira linha nova no golden set. É assim que a busca melhora depois do lançamento — com vocabulário real, não com consulta imaginada.

---

## Definição de pronto (v1)

- Os 12 testes de aceite passando, mais o 13º (quantidade).
- `npm test` verde e `npm run typecheck` limpo.
- Kill switch testado em produção, desligando e religando.
- Uma semana de piloto com leitura humana de 100% das conversas, sem um único caso de compatibilidade afirmada errado, preço dito ou quantidade dita.
- Relatório das 07h chegando no WhatsApp do dono.
- Golden set com as 10 consultas reais (Task 0) mais o que o piloto revelou.

## O que fica para a v2

Estava fora do escopo desde o desenho e continua fora:

- **Pedido e reserva.** Sem preço não há total, e o fechamento é no balcão.
- **Painel web de atendimento.** O balcão responde pelo próprio WhatsApp.
- **Transcrição de áudio.** O agente pede texto ou foto; Whisper entra se o volume justificar.
- **Embeddings.** `pg_trgm` com a calibração atual entrega recall@3 100%; embedding só se entrar vocabulário que sinônimo não resolva.
- **Ligação com o MinasCaixa.** `contatos.telefone` já guarda a chave para fazer isso depois por consulta entre projetos, sem migração.
