import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { responder, type Deps, type Fala } from "../../src/agente/laco.js";

/**
 * Testes do laço de conversa sem tocar na API de verdade.
 *
 * O cliente Anthropic é substituído por um dublê que devolve respostas
 * combinadas e guarda o que foi enviado — é assim que dá para verificar o
 * formato da requisição (que é onde mora o bug de cache) sem gastar token.
 */

/** Resposta mínima da API; cada teste sobrescreve só o que lhe interessa. */
function resposta(parcial: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: "msg_teste",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...parcial,
  } as Anthropic.Message;
}

/**
 * Dublê do cliente. Devolve as respostas na ordem e repete a última quando
 * acabam — é o que deixa testar o teto de iterações com uma resposta só.
 */
function clienteFalso(respostas: Anthropic.Message[]) {
  const enviados: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;

  const anthropic = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        enviados.push(params);
        return respostas[Math.min(i++, respostas.length - 1)]!;
      },
    },
  } as unknown as Anthropic;

  return { anthropic, enviados };
}

function deps(anthropic: Anthropic, extra: Partial<Deps> = {}): Deps {
  return {
    anthropic,
    prompt: "REGRAS FIXAS DA LOJA",
    contexto: "# ESTA CONVERSA\nData/hora: 20/08/2026, 10:00:00",
    executar: async () => ({ resultado: {} }),
    ...extra,
  };
}

const PERGUNTA: Fala[] = [{ papel: "cliente", conteudo: "tem pastilha de freio da biz?" }];

const texto = (t: string) =>
  [{ type: "text", text: t, citations: null }] as Anthropic.ContentBlock[];

const ferramenta = (nome: string, id = "t1") =>
  [{ type: "tool_use", id, name: nome, input: {} }] as Anthropic.ContentBlock[];

function blocosSystem(params: Anthropic.MessageCreateParamsNonStreaming) {
  return params.system as Anthropic.TextBlockParam[];
}

describe("responder — o system que vai para a API", () => {
  it("separa as regras (cacheadas) do contexto do turno (solto)", async () => {
    const { anthropic, enviados } = clienteFalso([resposta({ content: texto("tem sim") })]);
    await responder(deps(anthropic), PERGUNTA);

    const system = blocosSystem(enviados[0]!);
    expect(system).toHaveLength(2);
    expect(system[0]!.text).toBe("REGRAS FIXAS DA LOJA");
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });

    // O contexto entra DEPOIS do breakpoint. Se entrasse antes, o relógio
    // mudaria o prefixo a cada mensagem e o cache nunca acertaria.
    expect(system[1]!.text).toContain("Data/hora");
    expect(system[1]!.cache_control).toBeUndefined();
  });

  it("mantém o bloco cacheado idêntico quando só o relógio muda", async () => {
    const { anthropic, enviados } = clienteFalso([resposta({ content: texto("ok") })]);

    await responder(deps(anthropic, { contexto: "Data/hora: 20/08/2026, 10:00:00" }), PERGUNTA);
    await responder(deps(anthropic, { contexto: "Data/hora: 20/08/2026, 10:00:07" }), PERGUNTA);

    expect(blocosSystem(enviados[0]!)[0]!.text).toBe(blocosSystem(enviados[1]!)[0]!.text);
  });

  it("dispensa o segundo bloco quando não há contexto", async () => {
    const { anthropic, enviados } = clienteFalso([resposta({ content: texto("ok") })]);
    await responder(deps(anthropic, { contexto: undefined }), PERGUNTA);

    expect(blocosSystem(enviados[0]!)).toHaveLength(1);
  });
});

describe("responder — histórico", () => {
  it("descarta o começo até a primeira fala do cliente", async () => {
    const { anthropic, enviados } = clienteFalso([resposta({ content: texto("ok") })]);

    // A API devolve 400 se a conversa começar por uma fala do assistente, e o
    // corte no teto de mensagens da conversa cai justamente no meio dela.
    await responder(deps(anthropic), [
      { papel: "agente", conteudo: "era pra sua Fan 160?" },
      { papel: "humano", conteudo: "chegou hoje" },
      { papel: "cliente", conteudo: "e a pastilha?" },
    ]);

    expect(enviados[0]!.messages).toHaveLength(1);
    expect(enviados[0]!.messages[0]!.role).toBe("user");
  });

  it("chama o balcão sem gastar token quando não há fala do cliente", async () => {
    const { anthropic, enviados } = clienteFalso([resposta({ content: texto("ok") })]);

    const turno = await responder(deps(anthropic), [{ papel: "agente", conteudo: "oi" }]);

    expect(turno.handoff?.motivo).toBe("falha_tecnica");
    expect(enviados).toHaveLength(0);
  });
});

describe("responder — turnos que não dão resposta boa", () => {
  it("chama o balcão em vez de mandar mensagem vazia", async () => {
    const { anthropic } = clienteFalso([resposta({ content: [] })]);

    const turno = await responder(deps(anthropic), PERGUNTA);

    expect(turno.texto).not.toBe("");
    expect(turno.handoff?.motivo).toBe("falha_tecnica");
  });

  it("não entrega ao cliente uma resposta cortada no teto de tokens", async () => {
    const { anthropic } = clienteFalso([
      resposta({ content: texto("Tem sim. Retentor diant"), stop_reason: "max_tokens" }),
    ]);

    const turno = await responder(deps(anthropic), PERGUNTA);

    expect(turno.texto).not.toContain("Retentor diant");
    expect(turno.handoff?.motivo).toBe("falha_tecnica");
  });

  it("chama o balcão quando o modelo recusa responder", async () => {
    const { anthropic } = clienteFalso([
      resposta({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      }),
    ]);

    const turno = await responder(deps(anthropic), PERGUNTA);

    expect(turno.handoff?.motivo).toBe("recusa");
    expect(turno.handoff?.resumo).toContain("cyber");
  });

  it("chama o balcão quando não fecha em cinco passos", async () => {
    const { anthropic, enviados } = clienteFalso([
      resposta({ content: ferramenta("buscar_peca"), stop_reason: "tool_use" }),
    ]);

    const turno = await responder(deps(anthropic), PERGUNTA);

    expect(enviados).toHaveLength(5);
    expect(turno.handoff?.motivo).toBe("ambiguidade");
  });
});

describe("responder — ferramentas", () => {
  it("devolve todos os tool_result numa mensagem só", async () => {
    const pedido = [
      { type: "tool_use", id: "t1", name: "identificar_moto", input: { texto: "biz" } },
      { type: "tool_use", id: "t2", name: "buscar_peca", input: { texto: "pastilha" } },
    ] as Anthropic.ContentBlock[];

    const { anthropic, enviados } = clienteFalso([
      resposta({ content: pedido, stop_reason: "tool_use" }),
      resposta({ content: texto("Tem sim. Pastilha de freio Biz, código 4402.") }),
    ]);

    const chamadas: string[] = [];
    const turno = await responder(
      deps(anthropic, {
        executar: async (nome) => {
          chamadas.push(nome);
          return { resultado: { ok: true } };
        },
      }),
      PERGUNTA,
    );

    expect(chamadas).toEqual(["identificar_moto", "buscar_peca"]);
    expect(turno.texto).toContain("código 4402");

    // Separar os resultados em duas mensagens ensinaria o modelo a parar de
    // pedir ferramentas em paralelo.
    const ultima = enviados[1]!.messages.at(-1)!;
    expect(ultima.role).toBe("user");
    expect(ultima.content).toHaveLength(2);
  });

  it("para na hora em que a ferramenta pede handoff", async () => {
    const { anthropic, enviados } = clienteFalso([
      resposta({ content: ferramenta("transferir_humano"), stop_reason: "tool_use" }),
      resposta({ content: texto("não deveria chegar aqui") }),
    ]);

    const turno = await responder(
      deps(anthropic, {
        executar: async () => ({
          resultado: { transferido: true },
          efeito: { tipo: "handoff", motivo: "preco", resumo: "Biz — pastilha — falta o valor" },
        }),
      }),
      PERGUNTA,
    );

    expect(turno.handoff?.motivo).toBe("preco");
    expect(enviados).toHaveLength(1);
  });
});

describe("responder — contagem de tokens", () => {
  it("soma entrada nova, saída e cache em campos separados", async () => {
    const { anthropic } = clienteFalso([
      resposta({
        content: texto("ok"),
        usage: {
          input_tokens: 12,
          output_tokens: 30,
          cache_read_input_tokens: 2200,
          cache_creation_input_tokens: 0,
        },
      } as Partial<Anthropic.Message>),
    ]);

    const turno = await responder(deps(anthropic), PERGUNTA);

    // Somar tudo num número só esconderia se o cache está pegando.
    expect(turno.tokensIn).toBe(12);
    expect(turno.tokensOut).toBe(30);
    expect(turno.tokensCacheLidos).toBe(2200);
    expect(turno.tokensCacheGravados).toBe(0);
  });
});
