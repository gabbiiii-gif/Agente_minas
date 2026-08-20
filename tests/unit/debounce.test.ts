import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { criarDebounce } from "../../src/gateway/debounce.js";

/**
 * Timers falsos: teste de tempo não pode depender de tempo real, senão fica
 * lento e intermitente.
 */
describe("criarDebounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dispara uma vez depois da janela", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => {
      visto.push(c);
    });

    d.registrar("conversa-1");
    vi.advanceTimersByTime(7999);
    expect(visto).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(visto).toEqual(["conversa-1"]);
  });

  it("mensagem nova reinicia a janela e junta tudo num turno só", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => {
      visto.push(c);
    });

    d.registrar("conversa-1");
    vi.advanceTimersByTime(5000);
    d.registrar("conversa-1");
    vi.advanceTimersByTime(5000);
    expect(visto).toEqual([]); // a segunda reiniciou a contagem
    vi.advanceTimersByTime(3000);
    expect(visto).toEqual(["conversa-1"]);
  });

  it("conversas diferentes têm janelas independentes", () => {
    const visto: string[] = [];
    const d = criarDebounce(8000, (c) => {
      visto.push(c);
    });

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
    const d = criarDebounce(8000, (c) => {
      visto.push(c);
    });

    d.registrar("a");
    d.encerrar();
    vi.advanceTimersByTime(20000);
    expect(visto).toEqual([]);
  });

  /**
   * O gateway fica ligado o tempo todo. Exceção dentro de setTimeout é
   * uncaught no Node e derruba o processo inteiro: um turno que falha não
   * pode tirar o atendimento do ar para todo mundo.
   */
  it("sobrevive a um turno que lança", () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = criarDebounce(8000, () => {
      throw new Error("turno falhou");
    });

    d.registrar("a");
    expect(() => vi.advanceTimersByTime(8000)).not.toThrow();
    expect(d.pendentes()).toBe(0);
    expect(erros).toHaveBeenCalled();
  });

  it("sobrevive a um turno assíncrono que rejeita", async () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = criarDebounce(8000, async () => {
      throw new Error("turno falhou");
    });

    d.registrar("a");
    vi.advanceTimersByTime(8000);

    // A rejeição só chega ao catch no próximo tick de microtarefas.
    await Promise.resolve();
    await Promise.resolve();
    expect(erros).toHaveBeenCalled();
  });
});
