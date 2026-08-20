import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { enviar, type ConfigEvolution } from "../../src/saida/evolution.js";

const CFG: ConfigEvolution = {
  url: "http://localhost:8080",
  apiKey: "chave-de-teste",
  instancia: "minas",
};

const TEL = "5593999998888";

/** Pool falso: guarda o que foi gravado, sem banco. */
function poolFalso() {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, consultas };
}

const respostaOk = { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
const respostaErro = { ok: false, status: 502, text: async () => "caiu" } as unknown as Response;

/** Corpo enviado numa chamada do fetch mockado. */
function corpo(chamada: unknown[]): { number: string; text: string; delay: number } {
  return JSON.parse((chamada[1] as RequestInit).body as string);
}

/**
 * Timers falsos porque `enviar` dorme de propósito: atraso humano entre as
 * partes e espera crescente entre as tentativas. Sem isso o teste levaria
 * segundos de verdade.
 */
describe("enviar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("não chama a API para texto vazio", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);
    const { pool } = poolFalso();

    await enviar(pool, CFG, TEL, "   ");

    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("manda uma mensagem por parte, na ordem", async () => {
    const fetchFalso = vi.fn(async () => respostaOk);
    vi.stubGlobal("fetch", fetchFalso);
    const { pool, consultas } = poolFalso();

    const envio = enviar(pool, CFG, TEL, "Tem sim.\n\nQuer que eu separe?");
    await vi.advanceTimersByTimeAsync(20000);
    await envio;

    expect(fetchFalso).toHaveBeenCalledTimes(2);
    expect(corpo(fetchFalso.mock.calls[0]!).text).toBe("Tem sim.");
    expect(corpo(fetchFalso.mock.calls[1]!).text).toBe("Quer que eu separe?");
    expect(corpo(fetchFalso.mock.calls[0]!).number).toBe(TEL);
    // Nada pendente quando tudo entrou.
    expect(consultas).toHaveLength(0);
  });

  it("pede ao evolution para mostrar digitando antes de entregar", async () => {
    const fetchFalso = vi.fn(async () => respostaOk);
    vi.stubGlobal("fetch", fetchFalso);
    const { pool } = poolFalso();

    const envio = enviar(pool, CFG, TEL, "Tem sim.");
    await vi.advanceTimersByTimeAsync(20000);
    await envio;

    // Resposta instantânea denuncia robô.
    expect(corpo(fetchFalso.mock.calls[0]!).delay).toBeGreaterThanOrEqual(2000);
  });

  it("repete quando o evolution falha e segue quando dá certo", async () => {
    const fetchFalso = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(respostaErro)
      .mockResolvedValue(respostaOk);
    vi.stubGlobal("fetch", fetchFalso);
    const { pool, consultas } = poolFalso();

    const envio = enviar(pool, CFG, TEL, "Tem sim.");
    await vi.advanceTimersByTimeAsync(20000);
    await envio;

    expect(fetchFalso).toHaveBeenCalledTimes(2);
    expect(consultas).toHaveLength(0);
  });

  it("guarda em saidas_pendentes quando esgota as tentativas", async () => {
    const fetchFalso = vi.fn(async () => respostaErro);
    vi.stubGlobal("fetch", fetchFalso);
    const { pool, consultas } = poolFalso();

    // A resposta do cliente não pode se perder por instabilidade de
    // infraestrutura: some do WhatsApp, mas fica na fila para o dono ver.
    const erro = await (async () => {
      const envio = enviar(pool, CFG, TEL, "Tem sim.").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(20000);
      return envio;
    })();

    expect(erro).toBeInstanceOf(Error);
    expect(fetchFalso).toHaveBeenCalledTimes(3);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toContain("saidas_pendentes");
    expect(consultas[0]!.params[0]).toBe(TEL);
    expect(consultas[0]!.params[1]).toBe("Tem sim.");
  });

  it("sobrevive a erro de rede, não só a status ruim", async () => {
    const fetchFalso = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchFalso);
    const { pool, consultas } = poolFalso();

    const erro = await (async () => {
      const envio = enviar(pool, CFG, TEL, "Tem sim.").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(20000);
      return envio;
    })();

    expect(erro).toBeInstanceOf(Error);
    expect(consultas[0]!.sql).toContain("saidas_pendentes");
  });
});
