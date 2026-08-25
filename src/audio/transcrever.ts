/**
 * Transcrição do áudio que o cliente manda no WhatsApp.
 *
 * O Claude lê texto, imagem e PDF — não escuta áudio. Então o áudio precisa
 * virar texto antes de chegar ao agente, e isso exige um provedor à parte.
 * Até aqui o gateway simplesmente descartava `audioMessage`: o cliente
 * mandava o áudio e não recebia resposta nenhuma, o que do lado dele parece
 * a loja tendo ignorado. Áudio é como boa parte da clientela pede peça.
 *
 * O provedor padrão é a Groq, que serve o mesmo Whisper pela mesma API da
 * OpenAI por uma fração do preço — $0,111 a hora de áudio contra $0,36. A
 * chamada é HTTP direto, sem SDK: é uma requisição multipart só, e arrastar
 * mais uma dependência para dentro do bundle do Deno custaria mais do que o
 * código que ela pouparia. Trocar de provedor é trocar uma variável.
 *
 * Nunca lança. Falha de transcrição vira `{erro}` e quem chamou decide —
 * no gateway, decide passar para o balcão, que é melhor do que silêncio.
 */

/** Áudio do jeito que o Evolution entrega. */
export interface AudioRecebido {
  base64: string;
  mimetype: string;
  /** Segundos, quando o WhatsApp informa. Serve de guarda antes de gastar. */
  segundos?: number;
}

export interface ConfigTranscricao {
  apiKey: string;
  modelo: string;
  url: string;
  /** Vocabulário que o modelo deve esperar ouvir. Ver `CONTEXTO_PADRAO`. */
  contexto: string;
}

/**
 * Os dois provedores que servem o Whisper pela mesma API.
 *
 * Existe como preset porque endereço e modelo andam juntos: configurar a
 * chave da Groq e esquecer a URL manda o segredo de um serviço para o outro,
 * e o erro só aparece como 401 no primeiro áudio de cliente.
 */
const PROVEDORES: Record<string, { url: string; modelo: string }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    // `large-v3` e não `turbo`: 10,3% de erro de palavra contra 12%, por
    // sete centavos de dólar a mais por hora de áudio. Aqui a palavra errada
    // é o nome ou o código de uma peça, que vira busca errada e venda errada.
    modelo: "whisper-large-v3",
  },
  openai: {
    url: "https://api.openai.com/v1/audio/transcriptions",
    modelo: "whisper-1",
  },
};

/**
 * O que o modelo deve esperar ouvir.
 *
 * O Whisper transcreve som e não sabe do que a loja vive: sem isto "kit
 * relação" sai "quite relação", "Biz" sai "bis" e "retentor" sai "retentor"
 * ou "retendor" conforme o chiado. Nome de peça errado vira busca errada, que
 * é o pior jeito de errar aqui. O texto vai em português porque a
 * documentação pede o idioma do próprio áudio, e cabe em 224 tokens.
 */
const CONTEXTO_PADRAO =
  "Conversa de balcão de loja de peças de moto em Altamira, Pará. " +
  "Peças: retentor, pastilha de freio, kit relação, coroa, pinhão, vela, " +
  "óleo 20W50, rolamento, corrente, cabo de embreagem, farol, pisca, bateria, " +
  "amortecedor, guidão, carburador, filtro de ar, junta, cilindro, pneu. " +
  "Motos: Honda Titan, Fan, Biz, Pop, CG, Bros, XRE, Falcon; " +
  "Yamaha Factor, Fazer, Crosser, Lander, YBR; Suzuki Yes, Intruder.";

/**
 * Teto de tamanho. O da API é 25 MB; o daqui é menor de propósito, porque
 * áudio de dois minutos de WhatsApp tem uns 300 KB — acima de 8 MB não é
 * pergunta de balcão, é gravação longa, e gente atende melhor.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/** Acima disso o cliente está contando um caso, não pedindo uma peça. */
const MAX_SEGUNDOS = 300;

/** Prazo da chamada. Áudio curto transcreve em segundos; travar não. */
const TEMPO_LIMITE_MS = 45_000;

/**
 * Lê a configuração do ambiente, ou null quando não há chave.
 *
 * null é resposta legítima: sem chave o sistema segue funcionando, só que o
 * áudio passa direto para o balcão em vez de ser transcrito.
 */
export function lerConfigTranscricao(
  fonte: Record<string, string | undefined> = process.env,
): ConfigTranscricao | null {
  const apiKey = fonte.TRANSCRICAO_API_KEY?.trim();
  if (!apiKey) return null;

  const nome = fonte.TRANSCRICAO_PROVEDOR?.trim().toLowerCase() || "groq";
  const preset = PROVEDORES[nome] ?? PROVEDORES.groq!;

  return {
    apiKey,
    // As duas variáveis avulsas continuam valendo, para apontar a um serviço
    // compatível que não esteja na lista.
    modelo: fonte.TRANSCRICAO_MODELO?.trim() || preset.modelo,
    url: fonte.TRANSCRICAO_URL?.trim() || preset.url,
    contexto: fonte.TRANSCRICAO_CONTEXTO?.trim() || CONTEXTO_PADRAO,
  };
}

/** A extensão que o multipart precisa: a API decide o formato pelo nome. */
function extensaoDe(mimetype: string): string {
  const base = mimetype.split(";")[0]!.trim().toLowerCase();
  const mapa: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/amr": "amr",
    "audio/aac": "aac",
    "audio/flac": "flac",
  };
  // O WhatsApp manda ogg/opus na esmagadora maioria das vezes; o padrão
  // cobre o formato desconhecido sem impedir a tentativa.
  return mapa[base] ?? "ogg";
}

/** base64 para bytes, sem Buffer: o Deno da Edge Function não o tem. */
function paraBytes(base64: string): Uint8Array {
  const limpo = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const binario = atob(limpo);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export type Transcricao = { texto: string } | { erro: string };

/**
 * Transcreve o áudio para português.
 *
 * `language: pt` não é enfeite: sem ele o Whisper às vezes decide que um
 * áudio curto e chiado de oficina é espanhol, e devolve a transcrição
 * traduzida — que é pior do que nenhuma, porque parece certa.
 */
export async function transcrever(
  audio: AudioRecebido,
  cfg: ConfigTranscricao,
): Promise<Transcricao> {
  if (audio.segundos !== undefined && audio.segundos > MAX_SEGUNDOS) {
    return { erro: `áudio de ${Math.round(audio.segundos)}s, acima do limite de ${MAX_SEGUNDOS}s` };
  }

  let bytes: Uint8Array;
  try {
    bytes = paraBytes(audio.base64);
  } catch {
    return { erro: "áudio não veio em base64 legível" };
  }

  if (bytes.length === 0) return { erro: "áudio vazio" };
  if (bytes.length > MAX_BYTES) {
    return { erro: `áudio de ${Math.round(bytes.length / 1024)} KB, acima do limite` };
  }

  const forma = new FormData();
  forma.append(
    "file",
    new Blob([bytes], { type: audio.mimetype || "audio/ogg" }),
    `audio.${extensaoDe(audio.mimetype)}`,
  );
  forma.append("model", cfg.modelo);
  forma.append("language", "pt");
  forma.append("response_format", "json");
  // Temperatura zero é o que os dois provedores recomendam para transcrição:
  // aqui não se quer criatividade, se quer o que foi dito.
  forma.append("temperature", "0");
  if (cfg.contexto) forma.append("prompt", cfg.contexto);

  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      // Sem Content-Type de propósito: quem põe o boundary do multipart é o
      // próprio fetch, e declarar à mão quebra o corpo.
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: forma,
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });

    const bruto = await r.text();
    if (!r.ok) return { erro: `transcrição respondeu ${r.status}: ${bruto.slice(0, 200)}` };

    const texto = String(JSON.parse(bruto)?.text ?? "").trim();
    // Áudio de um segundo, ou só respiração, volta vazio. Tratar como falha
    // é o certo: mandar uma fala em branco ao agente não ajuda ninguém.
    return texto === "" ? { erro: "transcrição vazia" } : { texto };
  } catch (erro) {
    return { erro: `transcrição falhou: ${(erro as Error).message}` };
  }
}
