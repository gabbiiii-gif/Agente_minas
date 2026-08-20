import { describe, expect, it, vi, afterEach } from "vitest";
import { criarServidor } from "../../src/gateway/servidor.js";

const SEGREDO = "s3gr3d0";

const evento = (extra: Record<string, unknown> = {}) => ({
  event: "messages.upsert",
  data: {
    key: { remoteJid: "5593911110000@s.whatsapp.net", fromMe: false, id: "G-1" },
    pushName: "Teste",
    message: { conversation: "tem retentor pra titan 160?" },
    messageType: "conversation",
    ...extra,
  },
});

/** Deixa o processamento pós-resposta terminar antes de conferir. */
const proximoCiclo = () => new Promise((r) => setImmediate(r));

/**
 * A camada HTTP com o atendimento injetado: não toca banco, modelo nem
 * Evolution. O que se verifica aqui é o contrato do webhook — segredo,
 * status e o fato de o 200 sair antes do trabalho começar.
 */
describe("criarServidor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aceita o webhook com o segredo e repassa o corpo", async () => {
    const recebidos: unknown[] = [];
    const app = await criarServidor({
      segredo: SEGREDO,
      atender: async (corpo) => {
        recebidos.push(corpo);
      },
    });

    const r = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-webhook-segredo": SEGREDO },
      payload: evento(),
    });
    await proximoCiclo();

    expect(r.statusCode).toBe(200);
    expect(recebidos).toHaveLength(1);
    await app.close();
  });

  it("recusa webhook sem o segredo, sem chamar o atendimento", async () => {
    const atender = vi.fn(async () => {});
    const app = await criarServidor({ segredo: SEGREDO, atender });

    const r = await app.inject({ method: "POST", url: "/webhook", payload: evento() });

    expect(r.statusCode).toBe(401);
    expect(atender).not.toHaveBeenCalled();
    await app.close();
  });

  it("recusa webhook com o segredo errado", async () => {
    const atender = vi.fn(async () => {});
    const app = await criarServidor({ segredo: SEGREDO, atender });

    const r = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-webhook-segredo": "outro" },
      payload: evento(),
    });

    expect(r.statusCode).toBe(401);
    expect(atender).not.toHaveBeenCalled();
    await app.close();
  });

  it("responde 200 para evento que não interessa", async () => {
    const app = await criarServidor({ segredo: SEGREDO, atender: async () => {} });

    const r = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-webhook-segredo": SEGREDO },
      payload: { event: "connection.update", data: {} },
    });

    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("já respondeu 200 quando o atendimento falha", async () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await criarServidor({
      segredo: SEGREDO,
      atender: async () => {
        throw new Error("banco fora");
      },
    });

    // O 200 sai antes do trabalho: uma falha no atendimento não pode virar
    // erro HTTP, senão o Evolution reenvia e o cliente recebe duas vezes.
    const r = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-webhook-segredo": SEGREDO },
      payload: evento(),
    });
    await proximoCiclo();

    expect(r.statusCode).toBe(200);
    expect(erros).toHaveBeenCalled();
    await app.close();
  });

  it("tem healthcheck para o docker", async () => {
    const app = await criarServidor({ segredo: SEGREDO, atender: async () => {} });

    const r = await app.inject({ method: "GET", url: "/saude" });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
