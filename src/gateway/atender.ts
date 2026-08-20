import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { lerEvento } from "./payload.js";
import { criarDebounce } from "./debounce.js";
import { resolverContato, estaSilenciado, silenciarPorHumano } from "../conversa/contatos.js";
import {
  conversaAtiva,
  gravarMensagem,
  ultimasMensagens,
  contarMensagens,
  marcarStatus,
} from "../conversa/historico.js";
import { lerConfig, promptEfetivo } from "../config/loja.js";
import { montarContexto } from "../agente/prompt.js";
import { responder, MODELO_CONVERSA, type Fala, type Imagem } from "../agente/laco.js";
import { executarFerramenta } from "../ferramentas/executar.js";
import { enviar, type ConfigEvolution } from "../saida/evolution.js";

export interface DepsAtendimento {
  pool: Pool;
  anthropic: Anthropic;
  evolution: ConfigEvolution;
  /** Janela do debounce. O teste passa 0 para disparar na hora. */
  esperaDebounceMs?: number;
  /** Para onde vai o alerta quando o turno falha. null = ninguém é avisado. */
  telefoneDono?: string | null;
}

export interface Atendimento {
  /** Trata um webhook do Evolution, do começo ao ponto em que agenda o turno. */
  atender(corpo: unknown): Promise<void>;
  /** Roda o turno de uma conversa. Normalmente quem chama é o debounce. */
  responderTurno(conversaId: string): Promise<void>;
  /** Quantos turnos estão agendados. Serve ao teste e a um healthcheck futuro. */
  pendentes(): number;
  encerrar(): void;
}

/** Quantas falas anteriores vão para o modelo a cada turno. */
const JANELA_HISTORICO = 12;

const FRASE_BALCAO = "Vou chamar o pessoal do balcão aqui pra te atender. Um minuto.";
const FRASE_FALHA = "Só um minuto, já te respondo.";

/** Dados da conversa que o turno precisa e que não estão no id. */
interface DadosConversa {
  contatoId: string;
  telefone: string;
  nome: string | null;
  moto: string | null;
}

async function dadosDaConversa(pool: Pool, conversaId: string): Promise<DadosConversa | null> {
  const { rows } = await pool.query(
    `select c.contato_id, ct.telefone, ct.nome, m.marca, m.modelo, m.cilindrada
       from agente.conversas c
       join agente.contatos ct on ct.id = c.contato_id
       left join agente.motos m on m.id = ct.moto_id
      where c.id = $1`,
    [conversaId],
  );

  const r = rows[0];
  if (!r) return null;

  return {
    contatoId: r.contato_id,
    telefone: r.telefone,
    nome: r.nome,
    moto: r.modelo ? `${r.marca} ${r.modelo} ${r.cilindrada ?? ""}`.trim() : null,
  };
}

/**
 * Junta as peças num atendimento.
 *
 * A ordem importa e é a do spec: ler o evento, resolver o contato, gravar a
 * mensagem (sempre — o painel precisa ver a conversa inteira mesmo com a IA
 * calada) e só então decidir se o bot responde.
 */
export function criarAtendimento(deps: DepsAtendimento): Atendimento {
  const debounce = criarDebounce(deps.esperaDebounceMs ?? 8000, (conversaId) =>
    responderTurno(conversaId),
  );

  /**
   * Foto que chegou e ainda não entrou num turno, por conversa.
   *
   * Em memória pela mesma razão do debounce: se o processo cair, o cliente
   * reenvia. Guardar base64 no banco por 8 segundos não vale a migração.
   */
  const fotosPendentes = new Map<string, Imagem>();

  /** Avisa o dono por WhatsApp. Nunca lança: alerta que quebra é pior que alerta que falta. */
  async function avisarDono(texto: string): Promise<void> {
    if (!deps.telefoneDono) return;
    try {
      await enviar(deps.pool, deps.evolution, deps.telefoneDono, texto);
    } catch (erro) {
      console.error("não consegui avisar o dono:", erro);
    }
  }

  async function atender(corpo: unknown): Promise<void> {
    const evento = lerEvento(corpo);
    if ("descartar" in evento) {
      console.log(`webhook descartado: ${evento.descartar}`);
      return;
    }

    const contato = await resolverContato(deps.pool, evento.telefone, evento.nome);
    const conversa = await conversaAtiva(deps.pool, contato.id);
    const conteudo = evento.tipo === "texto" ? evento.texto : evento.legenda;
    const tipoMidia = evento.tipo === "imagem" ? "imagem" : "texto";

    // Mensagem saindo do próprio número da loja: o balcão respondeu pelo
    // celular. Registra como fala do humano e cala o bot — a IA não pode
    // falar por cima de quem já está atendendo.
    if (evento.fromMe) {
      await gravarMensagem(deps.pool, {
        conversaId: conversa.id,
        papel: "humano",
        conteudo,
        msgExtId: evento.msgExtId,
        tipoMidia,
      });
      await silenciarPorHumano(deps.pool, contato.id);
      await marcarStatus(deps.pool, conversa.id, "aguardando_humano");
      return;
    }

    const nova = await gravarMensagem(deps.pool, {
      conversaId: conversa.id,
      papel: "cliente",
      conteudo,
      msgExtId: evento.msgExtId,
      tipoMidia,
    });

    // Webhook repetido: o Evolution reenvia quando não recebe 200 a tempo.
    // Responder duas vezes é o erro que o cliente percebe na hora.
    if (!nova) return;

    if (evento.tipo === "imagem") {
      fotosPendentes.set(conversa.id, {
        base64: evento.midiaBase64,
        mimetype: evento.mimetype,
      });
    }

    // Daqui para baixo é só a decisão de o BOT responder ou não. A mensagem
    // já está gravada de qualquer jeito.
    if (estaSilenciado(contato, new Date())) return;
    if (conversa.status === "aguardando_humano") return;

    const cfg = await lerConfig(deps.pool);
    if (!cfg.botAtivo) return;

    // Conversa que passou do teto não vai fechar sozinha.
    if ((await contarMensagens(deps.pool, conversa.id)) > cfg.maxMensagensConversa) {
      await marcarStatus(deps.pool, conversa.id, "aguardando_humano", {
        desfecho: "handoff",
        resumo: `Conversa passou de ${cfg.maxMensagensConversa} mensagens sem fechar.`,
      });
      await enviar(deps.pool, deps.evolution, evento.telefone, FRASE_BALCAO);
      return;
    }

    debounce.registrar(conversa.id);
  }

  async function responderTurno(conversaId: string): Promise<void> {
    const dados = await dadosDaConversa(deps.pool, conversaId);
    if (dados === null) return;

    const foto = fotosPendentes.get(conversaId);
    fotosPendentes.delete(conversaId);

    try {
      const cfg = await lerConfig(deps.pool);
      const historico: Fala[] = (
        await ultimasMensagens(deps.pool, conversaId, JANELA_HISTORICO)
      ).map((m) => ({ papel: m.papel, conteudo: m.conteudo }));

      const turno = await responder(
        {
          anthropic: deps.anthropic,
          prompt: promptEfetivo(cfg),
          contexto: montarContexto({
            agora: new Date(),
            nome: dados.nome,
            moto: dados.moto,
          }),
          executar: (nome, entrada) =>
            executarFerramenta(
              deps.pool,
              { conversaId, contatoId: dados.contatoId },
              nome,
              entrada,
            ),
        },
        historico,
        foto,
      );

      // Grava antes de enviar: se o Evolution cair, a resposta fica no
      // histórico e o balcão vê o que a IA tinha respondido.
      await gravarMensagem(deps.pool, {
        conversaId,
        papel: "agente",
        conteudo: turno.texto,
        tokensIn: turno.tokensIn,
        tokensOut: turno.tokensOut,
        modelo: MODELO_CONVERSA,
      });

      await enviar(deps.pool, deps.evolution, dados.telefone, turno.texto);

      // `transferir_humano` já marcou a conversa lá dentro; isto cobre os
      // handoffs que o próprio laço decide (resposta truncada, recusa,
      // cinco passos sem fechar), que não passam por ferramenta nenhuma.
      if (turno.handoff) {
        await marcarStatus(deps.pool, conversaId, "aguardando_humano", {
          desfecho: "handoff",
          resumo: turno.handoff.resumo,
        });
      }
    } catch (erro) {
      // Chegou aqui com a Anthropic fora do ar (já passou pelos retries do
      // SDK) ou com o banco recusando. O cliente não pode ficar no vácuo:
      // avisa, entrega ao balcão e chama o dono.
      console.error(`turno da conversa ${conversaId} falhou:`, erro);

      await enviar(deps.pool, deps.evolution, dados.telefone, FRASE_FALHA).catch(() => {});
      await marcarStatus(deps.pool, conversaId, "aguardando_humano", {
        desfecho: "falha",
        resumo: `Falha técnica no atendimento: ${(erro as Error).message}`.slice(0, 500),
      }).catch(() => {});

      await avisarDono(
        `Falha no atendimento de ${dados.telefone}. A conversa foi passada para o balcão.`,
      );
    }
  }

  return {
    atender,
    responderTurno,
    pendentes: () => debounce.pendentes(),
    encerrar: () => debounce.encerrar(),
  };
}
