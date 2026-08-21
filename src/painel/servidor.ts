// Painel de controle do agente.
//
// O dono ajusta o atendimento, lê as conversas e assume o comando sem mexer
// em código: liga e desliga o bot, muda horário e endereço, edita as
// instruções, testa antes de salvar, e desliga a IA de uma conversa
// específica quando quer atender ele mesmo.
//
// As rotas são finas de propósito: quem faz o trabalho é `acoes.ts`, que
// serve tanto este Fastify quanto as funções serverless da Vercel. Se a
// lógica morasse aqui, existiria duas vezes e divergiria na primeira
// correção.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { criarPool } from "../db/pool.js";
import { lerEnv } from "../config/env.js";
import type { ConfigLoja } from "../config/loja.js";
import { senhaConfere, criarCookie, cookieDeSaida, sessaoValida } from "./auth.js";
import {
  acaoLerConfig,
  acaoGravarConfig,
  acaoListarConversas,
  acaoLerConversa,
  acaoAlternarIa,
  acaoMetricas,
  acaoTestar,
} from "./acoes.js";

// ESM não tem __dirname; o HTML mora ao lado deste arquivo.
const AQUI = dirname(fileURLToPath(import.meta.url));

/**
 * Rotas que existem justamente para quem ainda não entrou.
 *
 * `/api/sessao` precisa estar aqui: é ela que a tela consulta para decidir
 * entre mostrar o login e mostrar o painel. Protegida, responderia 401 a
 * quem ainda não entrou — que é exatamente a pergunta que ela responde.
 */
const LIVRES = new Set(["/api/entrar", "/api/sair", "/api/sessao"]);

export async function criarPainel(pool: Pool, anthropic: Anthropic) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  // Uma guarda só, em vez de repetir a checagem em cada rota: rota nova nasce
  // protegida por padrão, e esquecer de proteger é o erro que não se percebe.
  app.addHook("onRequest", async (req, resp) => {
    const caminho = req.url.split("?")[0]!;
    if (!caminho.startsWith("/api/") || LIVRES.has(caminho)) return;
    if (!sessaoValida(req.headers.cookie)) {
      return resp.code(401).send({ erro: "sessão expirada" });
    }
  });

  app.get("/", async (_req, resp) => {
    resp.type("text/html; charset=utf-8");
    return readFileSync(join(AQUI, "painel.html"), "utf8");
  });

  app.post("/api/entrar", async (req, resp) => {
    const { senha } = (req.body ?? {}) as { senha?: string };
    if (!senhaConfere(String(senha ?? ""))) {
      return resp.code(401).send({ erro: "senha incorreta" });
    }
    return resp.header("set-cookie", criarCookie()).send({ ok: true });
  });

  app.post("/api/sair", async (_req, resp) => {
    return resp.header("set-cookie", cookieDeSaida()).send({ ok: true });
  });

  /** Diz à tela se já há sessão, para ela decidir entre login e painel. */
  app.get("/api/sessao", async (req) => ({ entrou: sessaoValida(req.headers.cookie) }));

  app.get("/api/config", async () => acaoLerConfig(pool));

  app.put("/api/config", async (req, resp) => {
    const r = await acaoGravarConfig(pool, req.body as Partial<ConfigLoja>);
    return "erro" in r ? resp.code(400).send(r) : r;
  });

  app.get("/api/metricas", async () => acaoMetricas(pool));

  app.get("/api/conversas", async (req) => {
    const { busca } = req.query as { busca?: string };
    return acaoListarConversas(pool, busca ?? "");
  });

  app.get("/api/conversas/:id", async (req, resp) => {
    const { id } = req.params as { id: string };
    const r = await acaoLerConversa(pool, id);
    return "erro" in r ? resp.code(404).send(r) : r;
  });

  app.post("/api/conversas/:id/ia", async (req, resp) => {
    const { id } = req.params as { id: string };
    const { ativa } = (req.body ?? {}) as { ativa?: boolean };
    const r = await acaoAlternarIa(pool, id, ativa === true);
    return "erro" in r ? resp.code(404).send(r) : r;
  });

  app.post("/api/testar", async (req, resp) => {
    try {
      const r = await acaoTestar(pool, anthropic, req.body as Parameters<typeof acaoTestar>[2]);
      return "erro" in r ? resp.code(400).send(r) : r;
    } catch (erro) {
      return resp.code(500).send({ erro: (erro as Error).message });
    }
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = lerEnv();
  const pool = criarPool(env.databaseUrl);
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 });
  const app = await criarPainel(pool, anthropic);
  const porta = Number(process.env.PORTA_PAINEL ?? 3001);
  await app.listen({ port: porta, host: "127.0.0.1" });
  console.log(`Painel em http://localhost:${porta}`);
}
