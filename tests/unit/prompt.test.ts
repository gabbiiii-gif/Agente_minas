import { describe, expect, it } from "vitest";
import { montarPrompt, montarContexto, primeiroNome } from "../../src/agente/prompt.js";

const LOJA = {
  horario: "Seg a Sex 8h-18h · Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
};

const prompt = montarPrompt(LOJA);

/**
 * Estes testes travam as três regras que o negócio não pode perder.
 *
 * Se um deles quebrar depois de você editar o prompt, a pergunta certa não é
 * "como faço o teste passar" — é "a regra ainda está no texto?". Prompt é
 * fácil demais de editar sem perceber o que se apagou junto.
 */
describe("montarPrompt — regras que o negócio não pode perder", () => {
  it("proíbe informar preço e manda transferir para o balcão", () => {
    expect(prompt).toContain("# REGRA NÚMERO 1 — PREÇO");
    expect(prompt).toMatch(/NÃO tem acesso a preço/);
    expect(prompt).toMatch(/Nunca informe, estime, sugira faixa/);
    expect(prompt).toMatch(/transferir_humano/);
  });

  it("proíbe dizer quantidade em estoque", () => {
    expect(prompt).toContain("# REGRA NÚMERO 2 — DISPONIBILIDADE, NUNCA QUANTIDADE");
    expect(prompt).toMatch(/não sabe quantas unidades existem/);
    expect(prompt).toMatch(/tenho vários/);
  });

  it("só deixa afirmar compatibilidade quando o balcão confirmou", () => {
    expect(prompt).toContain("# REGRA NÚMERO 3 — COMPATIBILIDADE");
    expect(prompt).toMatch(/vier "humano"/);
    expect(prompt).toMatch(/NUNCA deduza compatibilidade/);
  });

  it("proíbe pedir licença para chamar o balcão", () => {
    // O agente perguntava "Gostaria que eu consultasse o balcão sobre isso?" e
    // ficava esperando. Pedir licença devolve ao cliente uma decisão que é do
    // agente, gasta um turno, e quem responde "não precisa" fica sem
    // atendimento nenhum — foi assim que uma conversa real morreu.
    const prompt = montarPrompt(LOJA);
    expect(prompt).toMatch(/NUNCA PEÇA LICENÇA PARA CHAMAR O BALCÃO/);
    expect(prompt).toMatch(/na MESMA mensagem/);
  });

  it("não deixa nenhuma pergunta de licença solta no texto", () => {
    // A regra acima não adianta se o corpo do prompt continuar dando exemplo
    // do contrário: o modelo copia o exemplo, não a regra. Então o bloco da
    // proibição — onde as frases aparecem de propósito, como exemplo do que
    // não fazer — sai da conta, e o resto do texto tem de estar limpo.
    const texto = montarPrompt(LOJA);
    const abre = texto.indexOf("# NUNCA PEÇA LICENÇA PARA CHAMAR O BALCÃO");
    const fecha = texto.indexOf("# PRECEDÊNCIA");
    expect(abre, "o bloco da proibição sumiu do prompt").toBeGreaterThan(-1);
    expect(fecha).toBeGreaterThan(abre);

    const sobraram = (texto.slice(0, abre) + texto.slice(fecha))
      .split("\n")
      .filter((l) => /quer que eu (veja|consulte|pergunte)|gostaria que eu|posso chamar/i.test(l));

    expect(sobraram, `pedido de licença fora da proibição: ${sobraram.join(" / ")}`).toHaveLength(0);
  });

  it("diz que o objetivo é entregar ao balcão, não conversar", () => {
    // O cliente reclamou que a IA conversa demais. A conversa real: o cliente
    // pediu tres pecas e o valor, e o agente gastou 1012 tokens de saida —
    // quatro vezes a media — para pedir foto e codigo, sem chamar o balcao.
    expect(prompt).toContain("# O QUE É SUCESSO AQUI");
    expect(prompt).toMatch(/chame o balcão/i);
  });

  it("transfere quando perguntam preço e não há peça fechada", () => {
    // Foi aqui que a venda morreu: pedir código a quem já quer comprar. Vale
    // tanto para busca vazia quanto para busca que achou coisa que não bate —
    // foi o segundo caso que escapou da primeira versão da regra.
    expect(prompt).toMatch(/NÃO tem uma peça fechada para oferecer/);
    expect(prompt).toMatch(/achou coisas que não batem com a moto/);
    expect(prompt).toMatch(/Não peça foto, não peça código/);
    // Sem esta linha a REGRA 3 vence e o agente volta a pedir a peça velha.
    expect(prompt).toMatch(/GANHA da REGRA 3/);
  });

  it("responde lista de peças de uma vez, não item por item", () => {
    expect(prompt).toContain("# VÁRIAS PEÇAS DE UMA VEZ");
    expect(prompt).toMatch(/Nunca trate item por item/i);
  });

  it("limita a mensagem a duas linhas e uma ideia", () => {
    expect(prompt).toMatch(/NO MÁXIMO 2 linhas/);
    expect(prompt).toMatch(/Uma ideia por mensagem/);
  });

  it("repete preço e quantidade na lista final de proibições", () => {
    const proibicoes = prompt.slice(prompt.indexOf("# PROIBIÇÕES"));
    expect(proibicoes).toMatch(/Nunca fale preço/);
    expect(proibicoes).toMatch(/Nunca diga quantidade em estoque/);
  });
});

/**
 * O cache da API casa por PREFIXO: qualquer byte que mude de uma mensagem
 * para a outra faz o cache nunca acertar. Estes testes existem para não
 * deixar o relógio voltar para dentro do bloco fixo.
 */
describe("montarPrompt — prefixo estável para o cache", () => {
  it("devolve exatamente o mesmo texto em chamadas diferentes", () => {
    expect(montarPrompt(LOJA)).toBe(montarPrompt(LOJA));
  });

  it("não carrega data, hora nem quem é o cliente", () => {
    expect(prompt).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(prompt).not.toContain("Data/hora:");
    expect(prompt).not.toContain("Cliente:");
    expect(prompt).not.toContain("Moto cadastrada:");
  });

  it("carrega horário e endereço, que só mudam quando o dono edita", () => {
    expect(prompt).toContain(LOJA.horario);
    expect(prompt).toContain(LOJA.endereco);
  });
});

describe("montarContexto — a parte que muda a cada mensagem", () => {
  const agora = new Date("2026-08-20T18:30:00Z");

  it("traz data, cliente e moto", () => {
    const ctx = montarContexto({ agora, nome: "João", moto: "Honda CG 160" });
    expect(ctx).toContain("Data/hora:");
    expect(ctx).toContain("João");
    expect(ctx).toContain("Honda CG 160");
  });

  it("diz explicitamente quando não conhece o cliente nem a moto", () => {
    const ctx = montarContexto({ agora, nome: null, moto: null });
    expect(ctx).toContain("não identificado");
    expect(ctx).toContain("nenhuma");
  });

  it("manda chamar o cliente pelo primeiro nome, junto do dado", () => {
    // A regra existia lá em cima, entre outras vinte, e o agente ignorava.
    // Colada no valor a que se aplica, e com o primeiro nome já calculado,
    // ele não precisa decidir qual pedaço de "Cleudemar Lima" usar.
    const ctx = montarContexto({ agora, nome: "Cleudemar Lima", moto: null });
    expect(ctx).toContain('chame-o de "Cleudemar"');
    expect(ctx).toMatch(/a cada 2 ou 3 mensagens/);
  });

  it("manda perguntar o nome junto com o atendimento, nunca antes", () => {
    // Pedir o nome primeiro custa um turno: o aceite pegou o agente
    // respondendo "Boa tarde! Com quem eu falo?" a quem só queria saber se
    // tinha retentor — sem buscar nada. A regra do nome continua, o custo não.
    const ctx = montarContexto({ agora, nome: null, moto: null });
    expect(ctx).toContain("não identificado");
    expect(ctx).toMatch(/com quem eu falo\?/i);
    expect(ctx).toMatch(/JUNTO com o atendimento/);
    expect(ctx).toMatch(/NUNCA antes de buscar/);
  });

  it("muda quando o relógio anda — por isso fica fora do bloco cacheado", () => {
    const antes = montarContexto({ agora, nome: null, moto: null });
    const depois = montarContexto({
      agora: new Date("2026-08-21T18:30:00Z"),
      nome: null,
      moto: null,
    });
    expect(antes).not.toBe(depois);
  });
});

/**
 * O nome vem do perfil do WhatsApp, que a pessoa escolhe — e escolhe coisas
 * que não são nome. Chamar alguém de "." é pior do que não chamar de nada.
 */
describe("primeiroNome", () => {
  it("usa só a primeira palavra", () => {
    expect(primeiroNome("Cleudemar Lima")).toBe("Cleudemar");
  });

  it("normaliza o caixa alta do perfil", () => {
    expect(primeiroNome("GABRIEL REIS")).toBe("Gabriel");
    expect(primeiroNome("gabriel")).toBe("Gabriel");
  });

  it("recusa o que não é nome, para o agente perguntar em vez de chutar", () => {
    for (const lixo of [null, "", "   ", ".", "😎", "123", "A", "!!!"]) {
      expect(primeiroNome(lixo), JSON.stringify(lixo)).toBeNull();
    }
  });

  it("guarda o hífen, que é nome de gente", () => {
    expect(primeiroNome("Ana-Maria Souza")).toBe("Ana-maria");
  });

  it("tira emoji grudado sem perder o nome", () => {
    expect(primeiroNome("Isa ☀️")).toBe("Isa");
  });
});
