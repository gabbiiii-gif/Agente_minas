import type { Pool } from "pg";
import { dividir } from "./dividir.js";

export interface ConfigEvolution {
  url: string;
  apiKey: string;
  instancia: string;
}

/** Atraso antes da primeira parte: resposta instantânea denuncia robô. */
const ESPERA_INICIAL_MS = [2000, 4000] as const;
/** Entre partes: tempo de quem está digitando a continuação. */
const ESPERA_ENTRE_MS = 1200;
const TENTATIVAS = 3;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aleatorio = ([min, max]: readonly [number, number]) => min + Math.random() * (max - min);

async function enviarParte(
  cfg: ConfigEvolution,
  telefone: string,
  texto: string,
  atrasoMs: number,
): Promise<void> {
  const resposta = await fetch(`${cfg.url}/message/sendText/${cfg.instancia}`, {
    method: "POST",
    headers: { apikey: cfg.apiKey, "Content-Type": "application/json" },
    // `delay` faz o Evolution mostrar "digitando..." antes de entregar.
    body: JSON.stringify({ number: telefone, text: texto, delay: Math.round(atrasoMs) }),
  });

  if (!resposta.ok) {
    throw new Error(`Evolution respondeu ${resposta.status}: ${await resposta.text()}`);
  }
}

/**
 * Entrega a resposta ao cliente, dividida e com ritmo humano.
 *
 * Se o Evolution estiver fora do ar depois de `TENTATIVAS`, a parte vai para
 * `saidas_pendentes` em vez de sumir — a resposta do cliente não pode se
 * perder por instabilidade de infraestrutura. Depois disso relança, para
 * quem chamou saber que o turno não chegou ao destino.
 */
export async function enviar(
  pool: Pool,
  cfg: ConfigEvolution,
  telefone: string,
  texto: string,
): Promise<void> {
  const partes = dividir(texto);
  if (partes.length === 0) return;

  for (const [i, parte] of partes.entries()) {
    const atraso = i === 0 ? aleatorio(ESPERA_INICIAL_MS) : ESPERA_ENTRE_MS;
    let ultimoErro: unknown = null;

    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      try {
        await enviarParte(cfg, telefone, parte, atraso);
        ultimoErro = null;
        break;
      } catch (erro) {
        // Pega status ruim e erro de rede no mesmo lugar: para o cliente, os
        // dois são a mesma coisa — a mensagem não chegou.
        ultimoErro = erro;
        // Só espera se ainda houver tentativa pela frente; dormir depois da
        // última é tempo de cliente jogado fora.
        if (tentativa < TENTATIVAS) await dormir(500 * tentativa);
      }
    }

    if (ultimoErro !== null) {
      await pool.query(
        `insert into agente.saidas_pendentes (telefone, conteudo, tentativas, erro)
         values ($1, $2, $3, $4)`,
        [telefone, parte, TENTATIVAS, (ultimoErro as Error).message.slice(0, 500)],
      );
      throw ultimoErro;
    }

    if (i < partes.length - 1) await dormir(ESPERA_ENTRE_MS);
  }
}
