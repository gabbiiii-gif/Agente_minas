// Painel de controle do agente.
//
// O dono ajusta o atendimento, lê as conversas e assume o comando sem mexer
// em código: liga e desliga o bot, troca o número do WhatsApp, muda a versão
// do agente, corrige o catálogo, edita as instruções, testa antes de salvar,
// e desliga a IA de uma conversa específica quando quer atender ele mesmo.
//
// As rotas são finas de propósito: quem faz o trabalho é `acoes.ts`,
// `catalogo.ts`, `versoes.ts` e `whatsapp.ts`, que servem tanto este Fastify
// quanto as funções serverless da Vercel. Se a lógica morasse aqui,
// existiria duas vezes e divergiria na primeira correção.
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
  acaoAlternarIaEmLote,
  acaoResponderManual,
  acaoMetricas,
  acaoDemandas,
  acaoSaidasPresas,
  acaoTestar,
} from "./acoes.js";
import {
  listarProdutos,
  salvarProduto,
  desativarProduto,
  motosDoProduto,
  confirmarFitment,
  listarMotos,
  listarServicos,
  salvarServico,
  excluirServico,
  prever,
} from "./catalogo.js";
import { listarVersoes, restaurarVersao, compararVersao, listarLog } from "./versoes.js";
import { situacao, pedirQr, desconectar, reiniciar } from "./whatsapp.js";

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

  /** Devolve o resultado, ou o código de erro que a ação pediu. */
  const ou = <T extends object>(resp: any, r: T, codigo: number) =>
    "erro" in r ? resp.code(codigo).send(r) : r;

  // ------------------------------------------------------------ configuração

  app.get("/api/config", async () => acaoLerConfig(pool));

  app.put("/api/config", async (req, resp) =>
    ou(resp, await acaoGravarConfig(pool, req.body as Partial<ConfigLoja>), 400),
  );

  // ------------------------------------------------------------------ visão

  app.get("/api/metricas", async () => acaoMetricas(pool));

  app.get("/api/demandas", async (req) => {
    const { dias } = req.query as { dias?: string };
    return acaoDemandas(pool, Number(dias) || 30);
  });

  app.get("/api/saidas", async () => acaoSaidasPresas(pool));

  app.get("/api/log", async () => listarLog(pool));

  // -------------------------------------------------------------- conversas

  app.get("/api/conversas", async (req) => {
    const { busca } = req.query as { busca?: string };
    return acaoListarConversas(pool, busca ?? "");
  });

  app.get("/api/conversas/:id", async (req, resp) =>
    ou(resp, await acaoLerConversa(pool, (req.params as { id: string }).id), 404),
  );

  // Antes de ":id": um caminho literal precisa ser declarado com o parâmetro
  // em mente, e "lote" nunca é um uuid, então nunca há ambiguidade real.
  app.post("/api/conversas/lote/ia", async (req, resp) => {
    const { ids, ativa } = (req.body ?? {}) as { ids?: string[]; ativa?: boolean };
    return ou(resp, await acaoAlternarIaEmLote(pool, ids, ativa === true), 400);
  });

  app.post("/api/conversas/:id/ia", async (req, resp) => {
    const { ativa } = (req.body ?? {}) as { ativa?: boolean };
    return ou(
      resp,
      await acaoAlternarIa(pool, (req.params as { id: string }).id, ativa === true),
      404,
    );
  });

  app.post("/api/conversas/:id/responder", async (req, resp) => {
    const { texto } = (req.body ?? {}) as { texto?: string };
    return ou(
      resp,
      await acaoResponderManual(pool, (req.params as { id: string }).id, String(texto ?? "")),
      400,
    );
  });

  // --------------------------------------------------------------- catálogo

  app.get("/api/produtos", async (req) => {
    const q = req.query as { busca?: string; filtro?: string; pagina?: string };
    return listarProdutos(pool, {
      busca: q.busca ?? "",
      filtro: q.filtro as any,
      pagina: Number(q.pagina) || 1,
    });
  });

  app.post("/api/produtos", async (req, resp) =>
    ou(resp, await salvarProduto(pool, req.body as any), 400),
  );

  app.put("/api/produtos/:id", async (req, resp) =>
    ou(
      resp,
      await salvarProduto(pool, { ...(req.body as any), id: (req.params as { id: string }).id }),
      400,
    ),
  );

  app.post("/api/produtos/:id/ativo", async (req, resp) => {
    const { ativo } = (req.body ?? {}) as { ativo?: boolean };
    return ou(
      resp,
      await desativarProduto(pool, (req.params as { id: string }).id, ativo === true),
      404,
    );
  });

  app.get("/api/produtos/:id/motos", async (req) =>
    motosDoProduto(pool, (req.params as { id: string }).id),
  );

  app.post("/api/produtos/:id/motos", async (req, resp) => {
    const { motoId, confirmado } = (req.body ?? {}) as { motoId?: string; confirmado?: boolean };
    return ou(
      resp,
      await confirmarFitment(
        pool,
        (req.params as { id: string }).id,
        String(motoId ?? ""),
        confirmado !== false,
      ),
      400,
    );
  });

  app.get("/api/motos", async (req) => {
    const { busca } = req.query as { busca?: string };
    return listarMotos(pool, busca ?? "");
  });

  app.post("/api/prever", async (req) => {
    const { texto } = (req.body ?? {}) as { texto?: string };
    return prever(pool, String(texto ?? ""));
  });

  // --------------------------------------------------------------- serviços

  app.get("/api/servicos", async (req) => {
    const { busca } = req.query as { busca?: string };
    return listarServicos(pool, busca ?? "");
  });

  app.post("/api/servicos", async (req, resp) =>
    ou(resp, await salvarServico(pool, req.body as any), 400),
  );

  app.put("/api/servicos/:id", async (req, resp) =>
    ou(
      resp,
      await salvarServico(pool, { ...(req.body as any), id: (req.params as { id: string }).id }),
      400,
    ),
  );

  app.delete("/api/servicos/:id", async (req, resp) =>
    ou(resp, await excluirServico(pool, (req.params as { id: string }).id), 404),
  );

  // ------------------------------------------------------- versões do agente

  app.get("/api/versoes", async () => listarVersoes(pool));

  app.get("/api/versoes/:numero/diff", async (req, resp) =>
    ou(resp, await compararVersao(pool, Number((req.params as { numero: string }).numero)), 404),
  );

  app.post("/api/versoes/restaurar", async (req, resp) => {
    const { numero } = (req.body ?? {}) as { numero?: number };
    return ou(resp, await restaurarVersao(pool, Number(numero)), 400);
  });

  // --------------------------------------------------------------- whatsapp

  app.get("/api/whatsapp", async () => situacao());
  app.post("/api/whatsapp/qr", async () => pedirQr());
  app.post("/api/whatsapp/desconectar", async (_req, resp) =>
    ou(resp, await desconectar(), 400),
  );
  app.post("/api/whatsapp/reiniciar", async (_req, resp) => ou(resp, await reiniciar(), 400));

  // ------------------------------------------------------------------ teste

  app.post("/api/testar", async (req, resp) => {
    try {
      const r = await acaoTestar(pool, anthropic, req.body as Parameters<typeof acaoTestar>[2]);
      return ou(resp, r, 400);
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
