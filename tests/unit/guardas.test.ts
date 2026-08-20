import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { avaliar, type Situacao } from "../../src/gateway/guardas.js";
import type { Contato } from "../../src/conversa/contatos.js";
import type { Conversa } from "../../src/conversa/historico.js";
import type { ConfigLoja } from "../../src/config/loja.js";

const AGORA = new Date("2026-08-20T12:00:00Z");

const CFG: ConfigLoja = {
  botAtivo: true,
  horario: "Seg a Sex 8h-18h",
  endereco: "Av. Tancredo Neves, 1200",
  tetoContatosNovosHora: 12,
  maxMensagensConversa: 30,
  promptCustomizado: null,
};

const CONTATO: Contato = {
  id: "contato-1",
  telefone: "5593999998888",
  nome: "Zé",
  motoId: null,
  silenciadoAte: null,
  novo: false,
};

const CONVERSA: Conversa = { id: "conversa-1", status: "ativa", iniciadaEm: AGORA };

/** Pool falso: `avaliar` só o usa para contar contatos novos da última hora. */
const poolCom = (novosNaHora: number) =>
  ({
    query: async () => ({ rows: [{ n: String(novosNaHora) }] }),
  }) as unknown as Pool;

const situacao = (mudancas: Partial<Situacao> = {}): Situacao => ({
  contato: CONTATO,
  conversa: CONVERSA,
  cfg: CFG,
  mensagensNaConversa: 4,
  agora: AGORA,
  ...mudancas,
});

/**
 * A política inteira de "o bot fala ou não" em um lugar só. Cada caso aqui é
 * uma razão diferente para o agente ficar quieto, e todas já custaram
 * dinheiro ou risco a alguém em algum projeto.
 */
describe("avaliar", () => {
  it("responde quando não há nada no caminho", async () => {
    const v = await avaliar(poolCom(1), situacao());
    expect(v.acao).toBe("responder");
  });

  it("cala com o bot desligado no painel", async () => {
    const v = await avaliar(poolCom(1), situacao({ cfg: { ...CFG, botAtivo: false } }));
    expect(v.acao).toBe("calar");
    expect(v.motivo).toContain("desligado");
  });

  it("cala quando a conversa já está com o balcão", async () => {
    const v = await avaliar(
      poolCom(1),
      situacao({ conversa: { ...CONVERSA, status: "aguardando_humano" } }),
    );
    expect(v.acao).toBe("calar");
  });

  it("cala enquanto o contato está silenciado", async () => {
    const v = await avaliar(
      poolCom(1),
      situacao({
        contato: { ...CONTATO, silenciadoAte: new Date("2026-08-20T17:00:00Z") },
      }),
    );
    expect(v.acao).toBe("calar");
  });

  it("volta a responder quando o silêncio vence", async () => {
    const v = await avaliar(
      poolCom(1),
      situacao({
        contato: { ...CONTATO, silenciadoAte: new Date("2026-08-20T11:00:00Z") },
      }),
    );
    expect(v.acao).toBe("responder");
  });

  it("entrega ao balcão avisando quando a conversa passa do teto", async () => {
    const v = await avaliar(poolCom(1), situacao({ mensagensNaConversa: 31 }));
    expect(v.acao).toBe("entregar_avisando");
    expect(v.motivo).toContain("30");
  });

  it("entrega calado quando estoura o teto de contatos novos", async () => {
    // Avisar aqui seria mandar mensagem para contato novo — exatamente o que
    // o teto existe para evitar.
    const v = await avaliar(poolCom(13), situacao({ contato: { ...CONTATO, novo: true } }));
    expect(v.acao).toBe("entregar_calado");
    expect(v.motivo).toContain("13");
  });

  it("não aplica o teto de contatos novos a quem já era cliente", async () => {
    const v = await avaliar(poolCom(99), situacao());
    expect(v.acao).toBe("responder");
  });

  it("atende contato novo enquanto o teto não encheu", async () => {
    const v = await avaliar(poolCom(12), situacao({ contato: { ...CONTATO, novo: true } }));
    expect(v.acao).toBe("responder");
  });

  it("o kill switch ganha de todo o resto", async () => {
    const v = await avaliar(
      poolCom(99),
      situacao({
        cfg: { ...CFG, botAtivo: false },
        contato: { ...CONTATO, novo: true },
        mensagensNaConversa: 999,
      }),
    );
    expect(v.acao).toBe("calar");
    expect(v.motivo).toContain("desligado");
  });
});
