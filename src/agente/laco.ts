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
  /** Parte fixa do system: identidade e regras. É o prefixo que vai ao cache. */
  prompt: string;
  /** Parte volátil do system: data, cliente, moto. Fica fora do cache. */
  contexto?: string;
  /** Recebe cada chamada de ferramenta — serve ao CLI e ao log de produção. */
  aoUsarFerramenta?: (nome: string, entrada: unknown, resultado: unknown) => void;
}

/**
 * Consumo do turno inteiro, somando todas as idas ao modelo.
 *
 * Os três tipos de entrada ficam separados porque têm preços diferentes:
 * entrada nova custa 1x, leitura de cache ~0,1x e gravação de cache ~1,25x.
 * Somar tudo num número só esconderia justamente o que interessa saber — se
 * o cache está pegando. `tokensCacheLidos` zerado turno após turno quer dizer
 * que alguma coisa volátil voltou para dentro do prompt fixo.
 */
export interface Uso {
  tokensIn: number;
  tokensOut: number;
  tokensCacheLidos: number;
  tokensCacheGravados: number;
}

export interface Turno extends Uso {
  texto: string;
  handoff?: Efeito;
}

/** Teto de idas ao modelo por turno. Acima disso o agente está perdido. */
const MAX_ITERACOES = 5;

/**
 * Folga de saída por ida ao modelo.
 *
 * Os tokens de raciocínio saem deste mesmo teto, então ele não pode ter o
 * tamanho da resposta que o cliente lê: com 1024 bastava o modelo pensar um
 * pouco mais para a mensagem chegar cortada no meio da frase.
 */
const MAX_TOKENS = 4096;

const FRASE_HANDOFF = "Vou chamar o pessoal do balcão aqui pra te atender. Um minuto.";

function usoZerado(): Uso {
  return { tokensIn: 0, tokensOut: 0, tokensCacheLidos: 0, tokensCacheGravados: 0 };
}

/**
 * Desiste do turno e chama o balcão.
 *
 * Todo caminho em que o agente não consegue produzir uma resposta boa termina
 * aqui: para o cliente, falar com gente é sempre melhor do que receber meia
 * frase, uma mensagem em branco ou silêncio.
 */
function chamarBalcao(motivo: string, resumo: string, uso: Uso): Turno {
  return { texto: FRASE_HANDOFF, handoff: { tipo: "handoff", motivo, resumo }, ...uso };
}

/**
 * Roda um turno de conversa: monta o contexto, deixa o modelo usar as
 * ferramentas e devolve o texto para o cliente.
 *
 * Sai do laço quando o modelo responde em texto, quando pede handoff, ou
 * quando estoura `MAX_ITERACOES` — e neste último caso transfere por
 * ambiguidade, porque agente que não converge em cinco passos vai enrolar o
 * cliente e queimar token.
 */
export async function responder(
  deps: Deps,
  historico: Fala[],
  imagem?: Imagem,
): Promise<Turno> {
  const uso = usoZerado();

  // A API exige que a conversa comece por uma fala do cliente e devolve 400
  // se o primeiro item for do assistente. O histórico chega cortado no teto
  // de mensagens da conversa, e esse corte cai com frequência numa fala do
  // agente ou do balcão — por isso descartamos tudo até o primeiro "cliente".
  const inicio = historico.findIndex((m) => m.papel === "cliente");
  if (inicio === -1) {
    return chamarBalcao(
      "falha_tecnica",
      "Histórico sem nenhuma fala do cliente; não havia o que responder.",
      uso,
    );
  }

  const mensagens: Anthropic.MessageParam[] = historico.slice(inicio).map((m) => ({
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

  // Dois blocos de propósito. O breakpoint do cache fecha no primeiro, então
  // o prefixo cacheado é `tools` + regras — e os dois só mudam quando alguém
  // edita as instruções no painel. O contexto do turno vem depois do
  // breakpoint: se entrasse antes, o relógio invalidaria o prefixo a cada
  // mensagem e o cache nunca acertaria.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: deps.prompt, cache_control: { type: "ephemeral" } },
  ];
  if (deps.contexto) system.push({ type: "text", text: deps.contexto });

  for (let i = 0; i < MAX_ITERACOES; i++) {
    const resposta = await deps.anthropic.messages.create({
      model: MODELO_CONVERSA,
      max_tokens: MAX_TOKENS,
      system,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: DEFINICOES,
      messages: mensagens,
    });

    uso.tokensIn += resposta.usage.input_tokens;
    uso.tokensOut += resposta.usage.output_tokens;
    uso.tokensCacheLidos += resposta.usage.cache_read_input_tokens ?? 0;
    uso.tokensCacheGravados += resposta.usage.cache_creation_input_tokens ?? 0;

    // Resposta cortada no teto de tokens: o que sobrou está pela metade, e
    // mandar meia frase ao cliente é pior do que passar para o balcão. Sem
    // esta checagem o corte passava despercebido.
    if (resposta.stop_reason === "max_tokens") {
      return chamarBalcao(
        "falha_tecnica",
        `A resposta do modelo estourou ${MAX_TOKENS} tokens e veio truncada.`,
        uso,
      );
    }

    // Recusa do classificador de segurança: chega como HTTP 200, sem texto.
    // Sem esta checagem o cliente receberia uma mensagem em branco.
    if (resposta.stop_reason === "refusal") {
      return chamarBalcao(
        "recusa",
        `O modelo recusou responder (${resposta.stop_details?.category ?? "sem categoria"}).`,
        uso,
      );
    }

    const blocosFerramenta = resposta.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (blocosFerramenta.length === 0) {
      const texto = resposta.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      // Turno sem ferramenta e sem texto existe (só raciocínio, por exemplo).
      // Sem a guarda, o WhatsApp receberia uma mensagem vazia.
      if (texto === "") {
        return chamarBalcao(
          "falha_tecnica",
          "O modelo encerrou o turno sem escrever nada para o cliente.",
          uso,
        );
      }

      return { texto, ...uso };
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

    if (handoff) return { texto: FRASE_HANDOFF, handoff, ...uso };
  }

  return chamarBalcao(
    "ambiguidade",
    "O agente não fechou o atendimento em 5 passos; conversa precisa de humano.",
    uso,
  );
}
