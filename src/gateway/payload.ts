import { normalizarTelefone } from "../conversa/telefone.js";

export type Recebida =
  | {
      tipo: "texto";
      telefone: string;
      nome: string;
      texto: string;
      msgExtId: string;
      fromMe: boolean;
    }
  | {
      tipo: "imagem";
      telefone: string;
      nome: string;
      legenda: string;
      midiaBase64: string;
      mimetype: string;
      msgExtId: string;
      fromMe: boolean;
    };

export type Descarte = { descartar: string };

/** O Evolution manda vários eventos no mesmo webhook; só um interessa. */
const EVENTO_MENSAGEM = "messages.upsert";

/**
 * O texto vem em dois campos diferentes: `conversation` numa mensagem solta e
 * `extendedTextMessage.text` quando o cliente responde citando outra.
 */
function texto(msg: Record<string, any>): string | null {
  if (typeof msg.conversation === "string") return msg.conversation;
  if (typeof msg.extendedTextMessage?.text === "string") return msg.extendedTextMessage.text;
  return null;
}

/**
 * Traduz o evento cru do Evolution para o que o gateway sabe tratar.
 *
 * Nunca lança: webhook que explode faz o Evolution reenviar em laço. Tudo que
 * não dá para tratar vira `{descartar: motivo}`, e o motivo vai para o log —
 * é assim que se descobre formato novo depois de atualizar o Evolution.
 */
export function lerEvento(corpo: unknown): Recebida | Descarte {
  if (corpo === null || typeof corpo !== "object") return { descartar: "corpo não é objeto" };

  const c = corpo as Record<string, any>;
  const evento = String(c.event ?? "");
  if (evento !== EVENTO_MENSAGEM) {
    return { descartar: `evento ignorado: ${evento || "sem event"}` };
  }

  const dados = c.data;
  if (!dados || typeof dados !== "object") return { descartar: "sem data" };

  const jid = String(dados.key?.remoteJid ?? "");
  // Grupo tem descarte próprio (e não "remetente não é pessoa") porque é o
  // caso comum: o número da loja entra em grupo de bairro o tempo todo.
  if (/@g\.us$/i.test(jid)) return { descartar: "grupo" };

  const telefone = normalizarTelefone(jid);
  if (telefone === null) return { descartar: "remetente não é pessoa" };

  const msgExtId = String(dados.key?.id ?? "");
  if (msgExtId === "") return { descartar: "sem id de mensagem" };

  // fromMe não é descarte: é o balcão respondendo pelo celular, e o gateway
  // usa isso para silenciar a IA naquela conversa.
  const fromMe = dados.key?.fromMe === true;
  const nome = String(dados.pushName ?? "");
  const msg = (dados.message ?? {}) as Record<string, any>;

  if (msg.audioMessage) return { descartar: "audio" };

  const corpoTexto = texto(msg);
  if (corpoTexto !== null && corpoTexto.trim() !== "") {
    return { tipo: "texto", telefone, nome, texto: corpoTexto.trim(), msgExtId, fromMe };
  }

  const img = msg.imageMessage;
  if (img) {
    // `webhookBase64: true` na configuração do webhook põe o arquivo em
    // data.message.base64. Sem isso só vem a URL criptografada do WhatsApp,
    // que não dá para baixar sem as chaves da sessão — por isso o motivo do
    // descarte cita a configuração: é o que se vai procurar no log.
    const base64 = String(dados.message?.base64 ?? dados.base64 ?? "");
    if (base64 === "") {
      return { descartar: "imagem sem base64 — confira webhookBase64 no webhook" };
    }
    return {
      tipo: "imagem",
      telefone,
      nome,
      legenda: String(img.caption ?? "").trim(),
      midiaBase64: base64,
      mimetype: String(img.mimetype ?? "image/jpeg"),
      msgExtId,
      fromMe,
    };
  }

  return { descartar: "sem conteúdo tratável" };
}
