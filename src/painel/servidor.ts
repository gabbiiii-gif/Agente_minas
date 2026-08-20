// Painel de configuração do agente.
//
// Serve para o dono ajustar o atendimento sem mexer em código: liga e desliga
// o bot, muda horário e endereço, edita as instruções e testa o resultado
// contra o catálogo real antes de salvar.
//
// Escuta só em 127.0.0.1 de propósito — não tem senha, então não pode ficar
// exposto. Na VPS, acesse por túnel SSH:
//   ssh -L 3001:localhost:3001 usuario@servidor
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { criarPool } from "../db/pool.js";
import { lerEnv } from "../config/env.js";
import {
  lerConfig,
  gravarConfig,
  promptPadrao,
  promptEfetivo,
  type ConfigLoja,
} from "../config/loja.js";
import { montarContexto } from "../agente/prompt.js";
import { responder, type Fala } from "../agente/laco.js";
import { executarFerramenta } from "../ferramentas/executar.js";

// ESM não tem __dirname; o HTML mora ao lado deste arquivo.
const AQUI = dirname(fileURLToPath(import.meta.url));

export async function criarPainel(pool: Pool, anthropic: Anthropic) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.get("/", async (_req, resp) => {
    resp.type("text/html; charset=utf-8");
    return readFileSync(join(AQUI, "painel.html"), "utf8");
  });

  app.get("/api/config", async () => {
    const cfg = await lerConfig(pool, false);
    return { ...cfg, promptPadrao: promptPadrao(cfg) };
  });

  app.put("/api/config", async (req, resp) => {
    const c = req.body as Partial<ConfigLoja>;

    // Validação mínima, para o painel não gravar algo que derrube o agente.
    if (c.tetoContatosNovosHora !== undefined && !(c.tetoContatosNovosHora > 0)) {
      return resp.code(400).send({ erro: "teto de contatos novos precisa ser maior que zero" });
    }
    if (c.maxMensagensConversa !== undefined && !(c.maxMensagensConversa >= 5)) {
      return resp.code(400).send({ erro: "limite de mensagens precisa ser pelo menos 5" });
    }
    if (c.promptCustomizado !== undefined && c.promptCustomizado !== null
        && c.promptCustomizado.trim().length < 200) {
      return resp.code(400).send({
        erro: "instruções curtas demais — se quer voltar ao padrão, use o botão Restaurar",
      });
    }

    await gravarConfig(pool, c);
    return { ok: true };
  });

  app.get("/api/metricas", async () => {
    const um = async (sql: string) =>
      Number((await pool.query<{ n: string }>(sql)).rows[0]!.n);
    return {
      produtos: await um("select count(*)::text as n from agente.produtos where ativo"),
      comFitment: await um("select count(distinct produto_id)::text as n from agente.produto_moto"),
      motos: await um("select count(*)::text as n from agente.motos"),
      demandas: await um(
        "select count(*)::text as n from agente.demanda_nao_atendida where criado_em > now() - interval '30 days'",
      ),
    };
  });

  /**
   * Roda um turno com o prompt que está na tela, não com o que está salvo.
   * É o que permite testar uma mudança antes de ela valer para o cliente.
   */
  app.post("/api/testar", async (req, resp) => {
    const corpo = req.body as { mensagem?: string; prompt?: string; historico?: Fala[] };
    const mensagem = String(corpo.mensagem ?? "").trim();
    if (mensagem === "") return resp.code(400).send({ erro: "mensagem vazia" });

    const cfg = await lerConfig(pool, false);
    // Sem texto na tela, testa o que está valendo de verdade para o cliente
    // (o customizado, se o dono salvou um) — não o padrão do código.
    const prompt =
      corpo.prompt && corpo.prompt.trim() !== "" ? corpo.prompt : promptEfetivo(cfg);

    const historico: Fala[] = Array.isArray(corpo.historico) ? corpo.historico : [];
    if (historico.at(-1)?.conteudo !== mensagem) {
      historico.push({ papel: "cliente", conteudo: mensagem });
    }

    const ferramentas: string[] = [];
    try {
      const turno = await responder(
        {
          anthropic,
          prompt,
          // O mesmo contexto que a produção manda, para o teste não responder
          // com uma data diferente da que o cliente veria.
          contexto: montarContexto({ agora: new Date(), nome: null, moto: null }),
          // conversaId null: teste do painel não entra no funil de métricas.
          executar: (nome, entrada) =>
            executarFerramenta(pool, { conversaId: null, contatoId: null }, nome, entrada),
          aoUsarFerramenta: (nome, entrada) =>
            ferramentas.push(`${nome}(${JSON.stringify(entrada)})`),
        },
        historico,
      );
      return { ...turno, ferramentas };
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
