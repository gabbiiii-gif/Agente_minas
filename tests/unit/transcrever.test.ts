import { describe, expect, it, afterEach, vi } from "vitest";
import { transcrever, lerConfigTranscricao } from "../../src/audio/transcrever.js";

/**
 * A transcrição fala com um serviço de fora e é o primeiro passo de toda
 * mensagem de voz. Se ela lançar, o cliente não recebe nem o handoff — por
 * isso todo caminho de erro aqui precisa devolver `{erro}`, nunca explodir.
 */

const CFG = { apiKey: "chave", modelo: "whisper-1", url: "https://exemplo/transcricoes" };

/** "ABC" em base64, pequeno o bastante para não bater em teto nenhum. */
const AUDIO = { base64: "QUJD", mimetype: "audio/ogg; codecs=opus" };

const ORIGINAL = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL;
  vi.restoreAllMocks();
});

function fingirFetch(resposta: { status?: number; corpo: unknown } | Error) {
  const espiao = vi.fn(async () => {
    if (resposta instanceof Error) throw resposta;
    return {
      ok: (resposta.status ?? 200) < 400,
      status: resposta.status ?? 200,
      text: async () => JSON.stringify(resposta.corpo),
    } as unknown as Response;
  });
  globalThis.fetch = espiao as unknown as typeof fetch;
  return espiao;
}

describe("lerConfigTranscricao", () => {
  it("devolve null sem chave, para o áudio ir ao balcão em vez de quebrar", () => {
    expect(lerConfigTranscricao({})).toBeNull();
    expect(lerConfigTranscricao({ TRANSCRICAO_API_KEY: "   " })).toBeNull();
  });

  it("tem padrão de modelo e de endereço", () => {
    const cfg = lerConfigTranscricao({ TRANSCRICAO_API_KEY: "k" })!;
    expect(cfg.modelo).toBe("whisper-1");
    expect(cfg.url).toContain("openai.com");
  });

  it("deixa trocar modelo e endereço sem mexer em código", () => {
    const cfg = lerConfigTranscricao({
      TRANSCRICAO_API_KEY: "k",
      TRANSCRICAO_MODELO: "outro",
      TRANSCRICAO_URL: "https://local/v1/audio/transcriptions",
    })!;
    expect(cfg.modelo).toBe("outro");
    expect(cfg.url).toBe("https://local/v1/audio/transcriptions");
  });
});

describe("transcrever", () => {
  it("devolve o texto do áudio", async () => {
    fingirFetch({ corpo: { text: "  tem retentor da fan 160?  " } });
    expect(await transcrever(AUDIO, CFG)).toEqual({ texto: "tem retentor da fan 160?" });
  });

  it("manda o áudio como arquivo e pede português", async () => {
    const espiao = fingirFetch({ corpo: { text: "oi" } });
    await transcrever(AUDIO, CFG);

    const [endereco, init] = espiao.mock.calls[0] as unknown as [string, RequestInit];
    expect(endereco).toBe(CFG.url);

    const forma = init.body as FormData;
    expect(forma.get("model")).toBe("whisper-1");
    // Sem isto o Whisper às vezes decide que um áudio chiado é espanhol e
    // devolve a transcrição traduzida — pior que nenhuma, porque parece certa.
    expect(forma.get("language")).toBe("pt");
    // A API decide o formato pelo nome do arquivo, não pelo mimetype.
    expect((forma.get("file") as File).name).toBe("audio.ogg");
    // Content-Type à mão quebra o multipart: quem põe o boundary é o fetch.
    expect(Object.keys(init.headers ?? {})).toEqual(["Authorization"]);
  });

  it("recusa áudio comprido antes de gastar a chamada", async () => {
    const espiao = fingirFetch({ corpo: { text: "nao deveria chegar aqui" } });
    const r = await transcrever({ ...AUDIO, segundos: 3600 }, CFG);
    expect(r).toHaveProperty("erro");
    expect(espiao).not.toHaveBeenCalled();
  });

  it("trata transcrição vazia como falha", async () => {
    // Áudio de um segundo, ou só respiração, volta em branco. Mandar uma fala
    // vazia ao agente não ajuda ninguém.
    fingirFetch({ corpo: { text: "   " } });
    expect(await transcrever(AUDIO, CFG)).toHaveProperty("erro");
  });

  it("devolve o motivo quando o serviço recusa, sem lançar", async () => {
    fingirFetch({ status: 401, corpo: { error: { message: "invalid api key" } } });
    const r = await transcrever(AUDIO, CFG);
    expect((r as { erro: string }).erro).toContain("401");
  });

  it("devolve o motivo quando a rede cai, sem lançar", async () => {
    fingirFetch(new Error("conexão recusada"));
    const r = await transcrever(AUDIO, CFG);
    expect((r as { erro: string }).erro).toContain("conexão recusada");
  });

  it("recusa base64 ilegível", async () => {
    const espiao = fingirFetch({ corpo: { text: "x" } });
    const r = await transcrever({ base64: "", mimetype: "audio/ogg" }, CFG);
    expect(r).toHaveProperty("erro");
    expect(espiao).not.toHaveBeenCalled();
  });
});
