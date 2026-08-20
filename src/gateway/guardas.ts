import type { Pool } from "pg";
import { estaSilenciado, contatosNovosNaUltimaHora, type Contato } from "../conversa/contatos.js";
import type { Conversa } from "../conversa/historico.js";
import type { ConfigLoja } from "../config/loja.js";

/**
 * O que fazer com a mensagem depois de gravada.
 *
 * `calar` deixa a conversa como está — alguém já está cuidando dela.
 * `entregar_*` marca a conversa como do balcão; a diferença é se o cliente
 * recebe um aviso ou não, e essa distinção existe por causa do banimento:
 * mandar mensagem para contato novo é justamente o que o WhatsApp pune.
 */
export type Acao = "responder" | "calar" | "entregar_avisando" | "entregar_calado";

export interface Veredito {
  acao: Acao;
  /** Vai para o log e para o resumo da conversa. Escreva para quem for ler depois. */
  motivo: string;
}

export interface Situacao {
  contato: Contato;
  conversa: Conversa;
  cfg: ConfigLoja;
  mensagensNaConversa: number;
  agora: Date;
}

/**
 * Decide se o bot responde.
 *
 * Todas as razões para o agente ficar quieto moram aqui, em um lugar só e
 * fora do caminho de I/O — dá para ler a política inteira sem seguir o fluxo
 * do gateway. A ordem é do mais decisivo para o menos: o kill switch ganha de
 * tudo, porque é a primeira coisa que o dono usa quando o agente erra ao vivo.
 */
export async function avaliar(pool: Pool, s: Situacao): Promise<Veredito> {
  if (!s.cfg.botAtivo) {
    return { acao: "calar", motivo: "bot desligado no painel" };
  }

  if (s.conversa.status === "aguardando_humano") {
    return { acao: "calar", motivo: "conversa já está com o balcão" };
  }

  if (estaSilenciado(s.contato, s.agora)) {
    return { acao: "calar", motivo: "contato silenciado por atendimento humano" };
  }

  // Cliente que passa do teto sem fechar não vai fechar sozinho: está
  // enrolado, e o balcão resolve em uma frase o que o agente não resolveu em
  // trinta. Aqui avisa, porque é contato conhecido e já em conversa.
  if (s.mensagensNaConversa > s.cfg.maxMensagensConversa) {
    return {
      acao: "entregar_avisando",
      motivo: `conversa passou de ${s.cfg.maxMensagensConversa} mensagens sem fechar`,
    };
  }

  // Teto anti-banimento: número não oficial que de repente fala com muita
  // gente nova é padrão que o WhatsApp pune. Só conta para quem chegou
  // agora — conversa em andamento não aumenta risco nenhum.
  if (s.contato.novo) {
    const novos = await contatosNovosNaUltimaHora(pool);
    if (novos > s.cfg.tetoContatosNovosHora) {
      return {
        acao: "entregar_calado",
        motivo: `${novos} contatos novos na última hora, acima do teto de ${s.cfg.tetoContatosNovosHora}`,
      };
    }
  }

  return { acao: "responder", motivo: "" };
}
