import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { lerEvento } from "./payload.js";
import { criarDebounce, type Debounce } from "./debounce.js";
import { resolverContato, silenciarPorHumano } from "../conversa/contatos.js";
import {
  conversaAtiva,
  gravarMensagem,
  ultimasMensagens,
  contarMensagens,
  marcarStatus,
} from "../conversa/historico.js";
import { lerConfig, promptEfetivo } from "../config/loja.js";
import { montarContexto } from "../agente/prompt.js";
import { responder, type Fala, type Imagem } from "../agente/laco.js";
import { anotarAviso } from "../conversa/avisos.js";
import { executarFerramenta } from "../ferramentas/executar.js";
import { enviar, type ConfigEvolution } from "../saida/evolution.js";
import { avaliar } from "./guardas.js";
import { transcrever, lerConfigTranscricao } from "../audio/transcrever.js";

export interface DepsAtendimento {
  pool: Pool;
  anthropic: Anthropic;
  evolution: ConfigEvolution;
  /** Janela do debounce. O teste passa 0 para disparar na hora. */
  esperaDebounceMs?: number;
  /**
   * Quem agenda o turno. O padrao e o debounce em memoria, que so serve a
   * processo sempre ligado. Em serverless passa-se um que nao faz nada e
   * quem agenda e o proprio handler, com `esperarVez` — ver `janela.ts`.
   */
  debounce?: Debounce;
  /** Para onde vai o alerta quando o turno falha. null = ninguém é avisado. */
  telefoneDono?: string | null;
  /**
   * Como transcrever áudio. Ausente = o áudio vai direto para o balcão.
   *
   * Recebe por parâmetro em vez de ler o ambiente para o teste poder
   * exercitar os dois caminhos sem mexer em variável de processo.
   */
  transcricao?: { transcrever: typeof transcrever } | null;
}

export interface Atendimento {
  /**
   * Trata um webhook do Evolution ate a decisao de responder.
   *
   * Devolve o id da conversa quando o bot deve responder, e null quando nao
   * deve. Quem hospeda decide o que fazer com isso: o processo sempre ligado
   * entrega ao debounce em memoria, a funcao serverless espera a janela pelo
   * banco e roda o turno na mesma invocacao.
   */
  atender(corpo: unknown): Promise<string | null>;
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
  const debounce =
    deps.debounce ??
    criarDebounce(deps.esperaDebounceMs ?? 8000, (conversaId) => responderTurno(conversaId));

  /**
   * Foto que chegou e ainda não entrou num turno, por conversa.
   *
   * Em memória pela mesma razão do debounce: se o processo cair, o cliente
   * reenvia. Guardar base64 no banco por 8 segundos não vale a migração.
   */
  const fotosPendentes = new Map<string, Imagem>();

  /** Avisa o dono por WhatsApp. Nunca lança: alerta que quebra é pior que alerta que falta. */
  async function avisarDono(texto: string): Promise<void> {
    // A config ganha do ambiente: é o número que o dono escolheu no painel, e
    // trocar de aparelho não pode exigir deploy.
    const cfg = await lerConfig(deps.pool).catch(() => null);
    const numero = cfg?.telefoneDono ?? deps.telefoneDono;
    if (!numero) return;
    try {
      await enviar(deps.pool, deps.evolution, numero, texto);
      await anotarAviso(deps.pool, "alerta", texto, numero);
    } catch (erro) {
      console.error("não consegui avisar o dono:", erro);
      await anotarAviso(deps.pool, "alerta", texto, numero, (erro as Error).message);
    }
  }

  /**
   * Áudio vira texto antes de qualquer outra coisa.
   *
   * Devolve o que gravar como conteúdo e se o agente pode seguir. Quando a
   * transcrição não está configurada ou falha, o texto gravado diz o motivo
   * e `seguir` vem false — o áudio existe no histórico e o balcão assume,
   * em vez de o cliente ficar sem resposta como acontecia antes.
   */
  async function ouvir(
    evento: Extract<ReturnType<typeof lerEvento>, { tipo: "audio" }>,
  ): Promise<{ conteudo: string; seguir: boolean }> {
    const cfg = lerConfigTranscricao();
    if (cfg === null) {
      return { conteudo: "[áudio recebido — transcrição não configurada]", seguir: false };
    }

    const motor = deps.transcricao?.transcrever ?? transcrever;
    const r = await motor(
      { base64: evento.midiaBase64, mimetype: evento.mimetype, segundos: evento.segundos },
      cfg,
    );

    if ("erro" in r) {
      console.log(`áudio não transcrito: ${r.erro}`);
      return { conteudo: `[áudio recebido — não deu para transcrever: ${r.erro}]`, seguir: false };
    }
    return { conteudo: r.texto, seguir: true };
  }

  async function atender(corpo: unknown): Promise<string | null> {
    const evento = lerEvento(corpo);
    if ("descartar" in evento) {
      console.log(`webhook descartado: ${evento.descartar}`);
      return null;
    }

    // Numa mensagem que sai da loja, o `pushName` do evento é o perfil da
    // LOJA, não o do cliente — gravá-lo renomeava o contato para "Minas Auto
    // Peças" toda vez que o balcão respondia pelo celular, e o agente passava
    // a chamar o cliente pelo nome da própria loja.
    const contato = await resolverContato(
      deps.pool,
      evento.telefone,
      evento.fromMe ? "" : evento.nome,
    );
    const conversa = await conversaAtiva(deps.pool, contato.id);

    // A transcrição acontece antes de gravar para o histórico guardar o que
    // o cliente disse, e não um marcador que ninguém consegue ler depois.
    const ouvido = evento.tipo === "audio" ? await ouvir(evento) : null;

    const conteudo =
      evento.tipo === "texto"
        ? evento.texto
        : evento.tipo === "imagem"
          ? evento.legenda
          : ouvido!.conteudo;
    const tipoMidia =
      evento.tipo === "imagem" ? "imagem" : evento.tipo === "audio" ? "audio" : "texto";

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
      return null;
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
    if (!nova) return null;

    // Áudio que não virou texto: o agente não tem o que responder, e chutar
    // a partir de um marcador seria pior. Quem atende é o balcão.
    if (ouvido !== null && !ouvido.seguir) {
      await marcarStatus(deps.pool, conversa.id, "aguardando_humano", {
        desfecho: "handoff",
        resumo: "Cliente mandou áudio e o sistema não conseguiu transcrever.",
      });
      await enviar(
        deps.pool,
        deps.evolution,
        evento.telefone,
        "Recebi seu áudio. Vou chamar o pessoal do balcão aqui pra te atender. Um minuto.",
      ).catch((erro) => console.error("não consegui avisar sobre o áudio:", erro));
      return null;
    }

    if (evento.tipo === "imagem") {
      fotosPendentes.set(conversa.id, {
        base64: evento.midiaBase64,
        mimetype: evento.mimetype,
      });
    }

    // Daqui para baixo é só a decisão de o BOT responder ou não. A mensagem
    // já está gravada de qualquer jeito.
    const veredito = await avaliar(deps.pool, {
      contato,
      conversa,
      cfg: await lerConfig(deps.pool),
      mensagensNaConversa: await contarMensagens(deps.pool, conversa.id),
      agora: new Date(),
    });

    if (veredito.acao === "responder") {
      debounce.registrar(conversa.id);
      return conversa.id;
    }

    // O motivo vai para o log sempre: é como se descobre que o kill switch
    // está ligado, ou que o teto encheu, sem abrir o banco.
    console.log(`sem resposta automática na conversa ${conversa.id}: ${veredito.motivo}`);
    if (veredito.acao === "calar") return null;

    await marcarStatus(deps.pool, conversa.id, "aguardando_humano", {
      desfecho: "handoff",
      resumo: veredito.motivo,
    });

    // `entregar_calado` não manda nada de propósito: é o teto anti-banimento,
    // e mandar mensagem para contato novo é exatamente o risco que ele evita.
    if (veredito.acao === "entregar_avisando") {
      await enviar(deps.pool, deps.evolution, evento.telefone, FRASE_BALCAO);
    }

    return null;
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
          // O modelo vem da config para a troca no painel valer no minuto
          // seguinte, sem deploy.
          modelo: cfg.modeloConversa,
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
        modelo: turno.modelo,
      });

      await enviar(deps.pool, deps.evolution, dados.telefone, turno.texto);

      // Só os handoffs que o próprio laço decide (resposta truncada, recusa,
      // cinco passos sem fechar) são gravados aqui. Os que vêm de
      // `transferir_humano` a ferramenta já gravou, e regravar apagaria o
      // desfecho 'qualificou' que ela calcula — que é a métrica do piloto.
      if (turno.handoff?.origem === "laco") {
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
