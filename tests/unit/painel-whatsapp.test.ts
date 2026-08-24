import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { situacao, pedirQr, desconectar, reiniciar } from "../../src/painel/whatsapp.js";

/**
 * O painel fala com o Evolution, que é um serviço de fora e cai.
 *
 * Estes testes cobrem o que acontece quando ele cai: a tela precisa mostrar o
 * motivo, e não uma página de erro. Nenhuma função aqui pode lançar — se
 * lançar, o painel inteiro fica inacessível por causa de uma VPS fora do ar.
 */

const ORIGINAL = globalThis.fetch;

function fingirFetch(resposta: { status?: number; corpo: unknown } | Error) {
  globalThis.fetch = vi.fn(async () => {
    if (resposta instanceof Error) throw resposta;
    return {
      status: resposta.status ?? 200,
      text: async () => JSON.stringify(resposta.corpo),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("painel · whatsapp", () => {
  beforeEach(() => {
    process.env.EVOLUTION_URL = "http://evolution.teste";
    process.env.EVOLUTION_API_KEY = "chave";
    process.env.EVOLUTION_INSTANCIA = "minas";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL;
    vi.restoreAllMocks();
  });

  it("diz que não está configurado em vez de tentar chamar", async () => {
    delete process.env.EVOLUTION_URL;
    delete process.env.EVOLUTION_API_KEY;
    const chamou = vi.fn();
    globalThis.fetch = chamou as unknown as typeof fetch;

    const s = await situacao();

    expect(s.configurado).toBe(false);
    expect(s.erro).toContain("EVOLUTION_URL");
    expect(chamou).not.toHaveBeenCalled();
  });

  it("traduz o estado do Evolution para o vocabulário da tela", async () => {
    for (const [bruto, esperado] of [
      ["open", "conectado"],
      ["connecting", "conectando"],
      ["close", "desconectado"],
      ["", "sem_instancia"],
    ] as const) {
      fingirFetch({ corpo: { instance: { state: bruto } } });
      // "open" dispara a segunda chamada, que este mock atende com o mesmo
      // corpo — daí o número não vir e o teste olhar só o estado.
      expect((await situacao()).estado).toBe(esperado);
    }
  });

  it("devolve o motivo, e não uma exceção, quando o Evolution não responde", async () => {
    fingirFetch(new Error("conexão recusada"));

    const s = await situacao();
    expect(s.estado).toBe("sem_instancia");
    expect(s.erro).toContain("conexão recusada");

    expect((await pedirQr()).erro).toContain("conexão recusada");
    expect(await desconectar()).toEqual({ erro: expect.stringContaining("conexão recusada") });
    expect(await reiniciar()).toEqual({ erro: expect.stringContaining("conexão recusada") });
  });

  it("não pede QR para um número que já está conectado", async () => {
    fingirFetch({ corpo: { instance: { state: "open" } } });

    const p = await pedirQr();

    expect(p.estado).toBe("conectado");
    expect(p.qr).toBeNull();
    expect(p.erro).toBeNull();
  });

  it("entrega o QR como data URI, venha ele cru ou já prefixado", async () => {
    // O Evolution manda ora um, ora outro; a tag <img> só aceita o prefixado.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ instance: { state: "close" } }) })
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ base64: "AAAA" }) }) as any;

    const p = await pedirQr();
    expect(p.qr).toBe("data:image/png;base64,AAAA");
    expect(p.estado).toBe("conectando");
  });

  it("reclama quando o Evolution recusa desconectar", async () => {
    fingirFetch({ status: 401, corpo: { message: "unauthorized" } });
    const r = await desconectar();
    expect(r).toHaveProperty("erro");
    expect((r as { erro: string }).erro).toContain("unauthorized");
  });
});
