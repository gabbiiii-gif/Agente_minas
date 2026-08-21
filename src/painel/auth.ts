import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Sessão do painel: um cookie assinado, sem banco e sem estado no servidor.
 *
 * Serverless não guarda sessão entre invocações, então o próprio cookie
 * carrega a validade e a assinatura. Quem não tem a chave não consegue
 * forjar um cookie válido.
 */

const NOME_COOKIE = "painel_sessao";
const VALIDADE_HORAS = 12;

/** Segredo de assinatura. Sem ele configurado, o painel se recusa a abrir. */
function segredo(): string {
  const s = process.env.PAINEL_SEGREDO ?? "";
  if (s.length < 16) {
    throw new Error(
      "PAINEL_SEGREDO ausente ou curto demais (mínimo 16 caracteres). Sem ele o painel não sobe.",
    );
  }
  return s;
}

function assinar(dados: string): string {
  return createHmac("sha256", segredo()).update(dados).digest("base64url");
}

/** Compara sem vazar em quanto tempo a comparação falhou. */
function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function senhaConfere(tentativa: string): boolean {
  const esperada = process.env.PAINEL_SENHA ?? "";
  if (esperada === "") {
    throw new Error("PAINEL_SENHA não configurada. Sem senha o painel não pode ficar exposto.");
  }
  return iguais(tentativa, esperada);
}

export function criarCookie(): string {
  const expira = Date.now() + VALIDADE_HORAS * 3600_000;
  const corpo = `${expira}.${randomBytes(8).toString("hex")}`;
  const valor = `${corpo}.${assinar(corpo)}`;
  return [
    `${NOME_COOKIE}=${valor}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${VALIDADE_HORAS * 3600}`,
  ].join("; ");
}

export function cookieDeSaida(): string {
  return `${NOME_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

/** Lê o cookie do header e diz se a sessão é válida e não expirou. */
export function sessaoValida(cabecalhoCookie: string | undefined): boolean {
  if (!cabecalhoCookie) return false;

  const bruto = cabecalhoCookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${NOME_COOKIE}=`));
  if (!bruto) return false;

  const valor = bruto.slice(NOME_COOKIE.length + 1);
  const partes = valor.split(".");
  if (partes.length !== 3) return false;

  const corpo = `${partes[0]}.${partes[1]}`;
  if (!iguais(partes[2]!, assinar(corpo))) return false;

  const expira = Number(partes[0]);
  return Number.isFinite(expira) && expira > Date.now();
}
