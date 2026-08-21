// Serviço sempre ligado que recebe o webhook do Evolution.
//
// Diferente do painel, este escuta em 0.0.0.0: quem chama é o Evolution, de
// outro contêiner. A porta é protegida pelo segredo no header, não por rede.
import Fastify from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { pathToFileURL } from "node:url";
import { criarPool } from "../db/pool.js";
import { lerEnvGateway } from "../config/env.js";
import { criarAtendimento } from "./atender.js";

export interface DepsServidor {
  segredo: string;
  /**
   * Quem trata a mensagem. Obrigatório de propósito: um padrão silencioso
   * aqui significaria um gateway que responde 200 e não atende ninguém, e o
   * sintoma só apareceria em produção.
   */
  // O retorno é ignorado aqui: quem hospeda processo sempre ligado deixa o
  // debounce em memória agendar o turno. A função serverless usa o id que
  // `atender` devolve para esperar a janela pelo banco.
  atender: (corpo: unknown) => Promise<unknown>;
  /** Log estruturado do Fastify. Desligado no teste, ligado em produção. */
  log?: boolean;
}

export async function criarServidor(cfg: DepsServidor) {
  // Foto de WhatsApp em base64 passa fácil do padrão de 1 MB do Fastify.
  const app = Fastify({ logger: cfg.log ?? false, bodyLimit: 12 * 1024 * 1024 });

  app.get("/saude", async () => ({ ok: true }));

  app.post("/webhook", async (req, resp) => {
    if (req.headers["x-webhook-segredo"] !== cfg.segredo) {
      return resp.code(401).send({ erro: "segredo inválido" });
    }

    // Responde já e processa fora do ciclo do request: o Evolution reenvia o
    // webhook quando não recebe resposta rápida, e o turno leva segundos
    // (debounce + modelo). A idempotência por `msg_ext_id` é a rede de
    // segurança para o reenvio que escapar mesmo assim.
    //
    // O custo dessa escolha: depois do 200 não há como devolver 500, então
    // falha de banco não faz o Evolution reenviar. Quem segura a mensagem
    // nesse caso é `saidas_pendentes`, do lado da saída.
    resp.code(200).send({ ok: true });

    try {
      await cfg.atender(req.body);
    } catch (erro) {
      req.log.error({ erro }, "falha ao atender mensagem");
      console.error("falha ao atender mensagem:", erro);
    }
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = lerEnvGateway();
  const pool = criarPool(env.databaseUrl);
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 });

  const atendimento = criarAtendimento({
    pool,
    anthropic,
    evolution: {
      url: env.evolutionUrl,
      apiKey: env.evolutionApiKey,
      instancia: env.evolutionInstancia,
    },
    telefoneDono: env.telefoneDono,
  });

  const app = await criarServidor({
    segredo: env.webhookSegredo,
    atender: atendimento.atender,
    log: true,
  });

  await app.listen({ port: env.porta, host: "0.0.0.0" });
  console.log(`Gateway ouvindo em 0.0.0.0:${env.porta}`);
}
