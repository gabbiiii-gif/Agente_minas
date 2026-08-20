import type Anthropic from "@anthropic-ai/sdk";
import { DEFINICOES } from "../ferramentas/definicoes.js";
import type { Efeito } from "../ferramentas/executar.js";

export const MODELO_CONVERSA = "claude-sonnet-5";

/** Uma fala já gravada da conversa, do jeito que o laço consome. */
export interface Fala {
  papel: "cliente" | "agente" | "humano" | "sistema";
  conteudo: string;
}

export interface Imagem {
  base64: string;
  mimetype: string;
}

export interface Deps {
  anthropic: Anthropic;
  executar: (nome: string, entrada: unknown) => Promise<{ resultado: unknown; efeito?: Efeito }>;
  prompt: string;
  /** Recebe cada chamada de ferramenta — serve ao CLI e ao log de produção. */
  aoUsarFerramenta?: (nome: string, entrada: unknown, resultado: unknown) => void;
}

export interface Turno {
  texto: string;
  handoff?: Efeito;
  tokensIn: number;
  tokensOut: number;
}

/** Teto de idas ao modelo por turno. Acima disso o agente está perdido. */
const MAX_ITERACOES = 5;

const FRASE_HANDOFF = "Vou chamar o pessoal do balcão aqui pra te atender. Um minuto.";

/**
 * Roda um turno de conversa: monta o contexto, deixa o modelo usar as
 * ferramentas e devolve o texto para o cliente.
 *
 * Sai do laço em três situações: o modelo respondeu em texto, o modelo pediu
 * handoff, ou estourou `MAX_ITERACOES` — e neste último caso transfere por
 * ambiguidade, porque agente que não converge em cinco passos vai enrolar o
 * cliente e queimar token.
 */
export async function responder(
  deps: Deps,
  historico: Fala[],
  imagem?: Imagem,
): Promise<Turno> {
  const mensagens: Anthropic.MessageParam[] = historico.map((m) => ({
    role: m.papel === "cliente" ? "user" : "assistant",
    content: m.conteudo,
  }));

  // A foto entra colada na última fala do cliente, que é o que ela ilustra.
  if (imagem) {
    const ultima = mensagens.at(-1);
    const bloco: Anthropic.ImageBlockParam = {
      type: "image",
      source: {
        type: "base64",
        media_type: imagem.mimetype as Anthropic.Base64ImageSource["media_type"],
        data: imagem.base64,
      },
    };
    if (ultima?.role === "user" && typeof ultima.content === "string") {
      ultima.content = [bloco, { type: "text", text: ultima.content }];
    } else {
      mensagens.push({ role: "user", content: [bloco] });
    }
  }

  let tokensIn = 0;
  let tokensOut = 0;

  for (let i = 0; i < MAX_ITERACOES; i++) {
    const resposta = await deps.anthropic.messages.create({
      model: MODELO_CONVERSA,
      max_tokens: 1024,
      // O system é longo e igual em toda mensagem: cachear corta a maior
      // parte do custo de entrada da conversa.
      system: [
        { type: "text", text: deps.prompt, cache_control: { type: "ephemeral" } },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: DEFINICOES,
      messages: mensagens,
    });

    tokensIn += resposta.usage?.input_tokens ?? 0;
    tokensOut += resposta.usage?.output_tokens ?? 0;

    const blocosFerramenta = resposta.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (blocosFerramenta.length === 0) {
      const texto = resposta.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { texto, tokensIn, tokensOut };
    }

    mensagens.push({ role: "assistant", content: resposta.content });

    const resultados: Anthropic.ToolResultBlockParam[] = [];
    let handoff: Efeito | undefined;

    for (const bloco of blocosFerramenta) {
      const { resultado, efeito } = await deps.executar(bloco.name, bloco.input);
      deps.aoUsarFerramenta?.(bloco.name, bloco.input, resultado);
      resultados.push({
        type: "tool_result",
        tool_use_id: bloco.id,
        content: JSON.stringify(resultado),
      });
      if (efeito?.tipo === "handoff") handoff = efeito;
    }

    // Todos os tool_result vão numa mensagem só; separar ensina o modelo a
    // parar de pedir ferramentas em paralelo.
    mensagens.push({ role: "user", content: resultados });

    if (handoff) return { texto: FRASE_HANDOFF, handoff, tokensIn, tokensOut };
  }

  return {
    texto: FRASE_HANDOFF,
    handoff: {
      tipo: "handoff",
      motivo: "ambiguidade",
      resumo: "O agente não fechou o atendimento em 5 passos; conversa precisa de humano.",
    },
    tokensIn,
    tokensOut,
  };
}
