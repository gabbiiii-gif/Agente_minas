/**
 * A linha do painel com o Evolution: ver se o WhatsApp está conectado,
 * pedir QR novo e desconectar o número.
 *
 * Existe separado de `acoes.ts` porque é a única parte do painel que fala com
 * um serviço de fora. Quando o Evolution está fora do ar, o painel inteiro
 * não pode cair junto — todas as funções aqui devolvem estado, nunca lançam.
 *
 * O `whatsapp:parear` da linha de comando continua valendo; a diferença é que
 * agora o dono não precisa de terminal para trocar o número.
 */

export type EstadoConexao = "conectado" | "conectando" | "desconectado" | "sem_instancia";

export interface SituacaoWhatsapp {
  /** false = faltam EVOLUTION_URL/EVOLUTION_API_KEY neste ambiente. */
  configurado: boolean;
  instancia: string;
  estado: EstadoConexao;
  /** Número pareado, quando o Evolution informa. E.164 sem "+". */
  numero: string | null;
  nomePerfil: string | null;
  /** Mensagem para a tela quando alguma coisa deu errado. */
  erro: string | null;
}

interface Config {
  url: string;
  chave: string;
  instancia: string;
}

const TEMPO_LIMITE_MS = 8000;

function lerConfig(): Config | null {
  const url = process.env.EVOLUTION_URL?.trim();
  const chave = process.env.EVOLUTION_API_KEY?.trim();
  if (!url || !chave) return null;
  return {
    url: url.replace(/\/+$/, ""),
    chave,
    instancia: process.env.EVOLUTION_INSTANCIA?.trim() || "minas",
  };
}

/**
 * Chama o Evolution com prazo.
 *
 * Sem o `AbortSignal.timeout` uma VPS fora do ar segurava a requisição do
 * painel até o teto da função serverless — a tela ficava girando sem dizer
 * nada. Melhor errar em 8 segundos e mostrar o motivo.
 */
async function chamar(
  cfg: Config,
  caminho: string,
  init?: RequestInit,
): Promise<{ status: number; corpo: any }> {
  const r = await fetch(`${cfg.url}${caminho}`, {
    ...init,
    headers: { apikey: cfg.chave, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  const texto = await r.text();
  try {
    return { status: r.status, corpo: JSON.parse(texto) };
  } catch {
    return { status: r.status, corpo: texto };
  }
}

/** Traduz o vocabulário do Evolution para o que a tela mostra. */
function traduzir(bruto: string): EstadoConexao {
  if (bruto === "open") return "conectado";
  if (bruto === "connecting") return "conectando";
  if (bruto === "close") return "desconectado";
  return "sem_instancia";
}

function semConfig(): SituacaoWhatsapp {
  return {
    configurado: false,
    instancia: process.env.EVOLUTION_INSTANCIA?.trim() || "minas",
    estado: "sem_instancia",
    numero: null,
    nomePerfil: null,
    erro: "EVOLUTION_URL e EVOLUTION_API_KEY não estão configuradas neste ambiente.",
  };
}

/** Só os dígitos: o Evolution devolve o número como "5593991106818@s.whatsapp.net". */
function soNumero(bruto: unknown): string | null {
  const texto = String(bruto ?? "");
  const digitos = texto.split("@")[0]!.replace(/\D/g, "");
  return digitos === "" ? null : digitos;
}

export async function situacao(): Promise<SituacaoWhatsapp> {
  const cfg = lerConfig();
  if (!cfg) return semConfig();

  const base: SituacaoWhatsapp = {
    configurado: true,
    instancia: cfg.instancia,
    estado: "sem_instancia",
    numero: null,
    nomePerfil: null,
    erro: null,
  };

  try {
    const { corpo } = await chamar(cfg, `/instance/connectionState/${cfg.instancia}`);
    base.estado = traduzir(corpo?.instance?.state ?? corpo?.state ?? "");
  } catch (erro) {
    return { ...base, erro: `Evolution não respondeu: ${(erro as Error).message}` };
  }

  // O número só interessa quando há um pareado; pedir a lista de instâncias
  // num servidor compartilhado é a chamada mais pesada daqui.
  if (base.estado === "conectado") {
    try {
      const { corpo } = await chamar(
        cfg,
        `/instance/fetchInstances?instanceName=${encodeURIComponent(cfg.instancia)}`,
      );
      const lista = Array.isArray(corpo) ? corpo : [corpo];
      const alvo = lista.find(
        (i: any) => (i?.instance?.instanceName ?? i?.name) === cfg.instancia,
      ) ?? lista[0];
      const dados = alvo?.instance ?? alvo ?? {};
      base.numero = soNumero(dados.owner ?? dados.ownerJid ?? dados.number);
      base.nomePerfil = dados.profileName ?? dados.profilename ?? null;
    } catch {
      // Sem o número a tela ainda serve: o que importa é o estado.
    }
  }

  return base;
}

export interface Pareamento {
  qr: string | null;
  /** Código de 8 dígitos, para quem prefere digitar em vez de ler o QR. */
  codigo: string | null;
  estado: EstadoConexao;
  erro: string | null;
}

/**
 * Pede um QR novo, criando a instância se ela não existir.
 *
 * O QR expira em torno de 40 segundos e o Evolution gera outro sozinho — a
 * tela chama isto de novo em vez de guardar o código.
 */
export async function pedirQr(): Promise<Pareamento> {
  const cfg = lerConfig();
  if (!cfg) return { qr: null, codigo: null, estado: "sem_instancia", erro: semConfig().erro };

  try {
    const atual = await chamar(cfg, `/instance/connectionState/${cfg.instancia}`);
    const estado = traduzir(atual.corpo?.instance?.state ?? atual.corpo?.state ?? "");

    if (estado === "conectado") {
      return { qr: null, codigo: null, estado, erro: null };
    }

    // Estado primeiro, criação só se precisar: num Evolution compartilhado a
    // chave costuma ser da instância e não pode criar nada. Pedir a criação
    // antes de olhar o estado derrubaria com 401 uma instância que está lá.
    if (estado === "sem_instancia") {
      const criacao = await chamar(cfg, "/instance/create", {
        method: "POST",
        body: JSON.stringify({
          instanceName: cfg.instancia,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
        }),
      });

      if (criacao.status >= 400 && !JSON.stringify(criacao.corpo).includes("already in use")) {
        return {
          qr: null,
          codigo: null,
          estado,
          erro: `O Evolution recusou criar a instância: ${JSON.stringify(criacao.corpo).slice(0, 200)}`,
        };
      }

      const qr = criacao.corpo?.qrcode?.base64 ?? criacao.corpo?.base64 ?? null;
      if (qr) {
        return { qr: normalizarQr(qr), codigo: criacao.corpo?.qrcode?.code ?? null, estado: "conectando", erro: null };
      }
    }

    const conexao = await chamar(cfg, `/instance/connect/${cfg.instancia}`);
    const qr = conexao.corpo?.base64 ?? conexao.corpo?.qrcode?.base64 ?? null;
    const codigo = conexao.corpo?.pairingCode ?? conexao.corpo?.code ?? null;

    if (!qr && !codigo) {
      return { qr: null, codigo: null, estado, erro: "O Evolution não devolveu QR code." };
    }
    return { qr: qr ? normalizarQr(qr) : null, codigo, estado: "conectando", erro: null };
  } catch (erro) {
    return {
      qr: null,
      codigo: null,
      estado: "sem_instancia",
      erro: `Evolution não respondeu: ${(erro as Error).message}`,
    };
  }
}

/** O Evolution ora manda `data:image/png;base64,...`, ora só o base64. */
function normalizarQr(bruto: string): string {
  return bruto.startsWith("data:") ? bruto : `data:image/png;base64,${bruto}`;
}

/**
 * Desconecta o número atual. É o primeiro passo para trocar de número: o
 * WhatsApp antigo sai da lista de dispositivos conectados e o próximo QR
 * pareia outro aparelho.
 */
export async function desconectar(): Promise<{ ok: true } | { erro: string }> {
  const cfg = lerConfig();
  if (!cfg) return { erro: semConfig().erro! };

  try {
    const r = await chamar(cfg, `/instance/logout/${cfg.instancia}`, { method: "DELETE" });
    if (r.status >= 400) {
      return { erro: `O Evolution recusou desconectar: ${JSON.stringify(r.corpo).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (erro) {
    return { erro: `Evolution não respondeu: ${(erro as Error).message}` };
  }
}

/**
 * Reinicia a instância sem despareá-la.
 *
 * É o que resolve o caso chato: o Evolution diz "conectado" mas as mensagens
 * pararam de chegar. Reiniciar refaz o socket e mantém o número.
 */
export async function reiniciar(): Promise<{ ok: true } | { erro: string }> {
  const cfg = lerConfig();
  if (!cfg) return { erro: semConfig().erro! };

  try {
    const r = await chamar(cfg, `/instance/restart/${cfg.instancia}`, { method: "PUT" });
    if (r.status >= 400) {
      return { erro: `O Evolution recusou reiniciar: ${JSON.stringify(r.corpo).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (erro) {
    return { erro: `Evolution não respondeu: ${(erro as Error).message}` };
  }
}
