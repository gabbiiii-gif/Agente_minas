import type { Pool } from "pg";
import { lerConfig, gravarConfig } from "../config/loja.js";
import { normalizarTelefone } from "../conversa/telefone.js";
import { levantarDemanda, montarTexto } from "../relatorio/diario.js";
import { enviar } from "../saida/evolution.js";
import { registrar } from "./versoes.js";
import { anotarAviso, type TipoAviso } from "../conversa/avisos.js";

/**
 * O que o sistema manda para o telefone do dono.
 *
 * Duas coisas saem por ali sem ninguém pedir: o relatório diário de demanda,
 * pelo cron das 7h, e o alerta quando o atendimento falha. As duas eram
 * invisíveis — o dono só sabia que existiam quando chegavam, e quando não
 * chegavam não havia como distinguir "não teve o que relatar" de "o Evolution
 * recusou" de "o número está errado". Este módulo torna as três hipóteses
 * distinguíveis, e deixa o número mudável sem deploy.
 */

export type { TipoAviso };

export interface AvisoDono {
  id: number;
  tipo: TipoAviso;
  texto: string;
  telefone: string | null;
  enviado: boolean;
  erro: string | null;
  criadoEm: string;
}

/** Teto de um texto escrito à mão. Acima disso o WhatsApp fatia em pedaços. */
const MAX_TEXTO = 3000;

export interface PainelDono {
  /** Número em uso agora, já normalizado. null = ninguém é avisado. */
  telefone: string | null;
  /** O que vem de `TELEFONE_DONO`, para a tela dizer de onde saiu o padrão. */
  telefoneDoAmbiente: string | null;
  /** true quando o painel consegue enviar (Evolution configurado). */
  podeEnviar: boolean;
  /** O relatório de hoje, exatamente como chegaria. null = nada a contar. */
  previa: string | null;
  /** Quantas peças diferentes entraram na prévia. */
  itensNaPrevia: number;
  historico: AvisoDono[];
}

export async function verDono(pool: Pool, horas = 24): Promise<PainelDono> {
  const cfg = await lerConfig(pool, false);
  const linhas = await levantarDemanda(pool, horas);

  const { rows } = await pool.query(
    `select id, tipo, texto, telefone, enviado, erro, criado_em
       from agente.avisos_dono order by criado_em desc limit 50`,
  );

  return {
    telefone: cfg.telefoneDono,
    telefoneDoAmbiente: process.env.TELEFONE_DONO?.trim() || null,
    podeEnviar: Boolean(process.env.EVOLUTION_URL && process.env.EVOLUTION_API_KEY),
    // A prévia é montada pela MESMA função que o cron usa. Se fosse outra, a
    // tela mostraria uma coisa e o dono receberia outra — que é o defeito que
    // uma prévia existe para não ter.
    previa: montarTexto(linhas, horas),
    itensNaPrevia: linhas.length,
    historico: rows.map((r) => ({
      id: Number(r.id),
      tipo: r.tipo,
      texto: r.texto,
      telefone: r.telefone,
      enviado: r.enviado,
      erro: r.erro,
      criadoEm: r.criado_em,
    })),
  };
}

/**
 * Troca o número que recebe relatório e alerta.
 *
 * Passa pela mesma normalização das conversas: o dono digita
 * "(93) 99110-6818" e o Evolution precisa de "5593991106818". Sem isto, o
 * número entrava torto e o relatório sumia sem erro nenhum.
 */
export async function trocarTelefone(
  pool: Pool,
  bruto: string,
): Promise<{ ok: true; telefone: string | null } | { erro: string }> {
  const texto = String(bruto ?? "").trim();

  if (texto === "") {
    await gravarConfig(pool, { telefoneDono: null });
    await registrar(pool, "tirar_telefone_dono");
    return { ok: true, telefone: null };
  }

  const numero = normalizarTelefone(texto);
  if (numero === null) {
    return { erro: "número inválido — use DDD e o número, como 93991106818" };
  }

  await gravarConfig(pool, { telefoneDono: numero });
  await registrar(pool, "trocar_telefone_dono", { telefone: numero });
  return { ok: true, telefone: numero };
}

/**
 * Manda alguma coisa para o dono agora.
 *
 * `relatorio` monta o texto do dia; `manual` usa o que foi escrito na tela.
 * Os dois passam pelo mesmo caminho de envio e pelo mesmo registro, para o
 * histórico não mentir sobre um deles.
 */
export async function enviarAoDono(
  pool: Pool,
  corpo: { tipo?: TipoAviso; texto?: string; horas?: number },
): Promise<{ ok: true; texto: string } | { erro: string }> {
  const tipo: TipoAviso = corpo.tipo === "relatorio" ? "relatorio" : corpo.tipo === "teste" ? "teste" : "manual";
  const horas = Number(corpo.horas) || 24;

  let texto: string;
  if (tipo === "relatorio") {
    const montado = montarTexto(await levantarDemanda(pool, horas), horas);
    if (montado === null) {
      return { erro: `nenhuma peça ficou em falta nas últimas ${horas}h — não há relatório para mandar` };
    }
    texto = montado;
  } else if (tipo === "teste") {
    texto = "Teste do painel da Minas Auto Peças. Se você recebeu isto, o número está certo.";
  } else {
    texto = String(corpo.texto ?? "").trim();
    if (texto === "") return { erro: "mensagem vazia" };
    if (texto.length > MAX_TEXTO) return { erro: `mensagem longa demais (máximo ${MAX_TEXTO})` };
  }

  const cfg = await lerConfig(pool, false);
  if (!cfg.telefoneDono) {
    await anotarAviso(pool, tipo, texto, null, "sem telefone configurado");
    return { erro: "nenhum telefone configurado para o dono" };
  }

  const url = process.env.EVOLUTION_URL?.trim();
  const apiKey = process.env.EVOLUTION_API_KEY?.trim();
  if (!url || !apiKey) {
    await anotarAviso(pool, tipo, texto, cfg.telefoneDono, "Evolution não configurado neste ambiente");
    return { erro: "EVOLUTION_URL e EVOLUTION_API_KEY não estão configuradas neste ambiente" };
  }

  try {
    await enviar(
      pool,
      { url, apiKey, instancia: process.env.EVOLUTION_INSTANCIA?.trim() || "minas" },
      cfg.telefoneDono,
      texto,
    );
  } catch (erro) {
    const mensagem = (erro as Error).message;
    await anotarAviso(pool, tipo, texto, cfg.telefoneDono, mensagem);
    return { erro: `não saiu: ${mensagem}` };
  }

  await anotarAviso(pool, tipo, texto, cfg.telefoneDono);
  await registrar(pool, "enviar_ao_dono", { tipo });
  return { ok: true, texto };
}

