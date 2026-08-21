import { describe, expect, it, beforeAll } from "vitest";
import handler from "../../api/[...rota].js";

const SENHA = "senha-de-teste-do-painel";

/** Resposta falsa com a cara do que a Vercel entrega ao handler. */
function respostaFalsa() {
  const estado = {
    codigo: 0,
    corpo: undefined as unknown,
    cabecalhos: {} as Record<string, string>,
  };
  const resp = {
    status(c: number) {
      estado.codigo = c;
      return resp;
    },
    json(corpo: unknown) {
      estado.corpo = corpo;
    },
    setHeader(nome: string, valor: string) {
      estado.cabecalhos[nome] = valor;
    },
  };
  return { resp, estado };
}

const chamar = async (
  url: string,
  opcoes: { metodo?: string; cookie?: string; corpo?: unknown } = {},
) => {
  const { resp, estado } = respostaFalsa();
  await handler(
    {
      method: opcoes.metodo ?? "GET",
      url,
      headers: opcoes.cookie ? { cookie: opcoes.cookie } : {},
      body: opcoes.corpo,
      query: {},
    },
    resp,
  );
  return estado;
};

/**
 * O painel mostra conversa de cliente e vai ficar exposto na internet — a
 * autenticação é a única coisa entre ele e qualquer um. Estes testes cobrem
 * o handler da Vercel direto, sem subir servidor nenhum.
 */
describe("painel na vercel — sessão", () => {
  beforeAll(() => {
    process.env.PAINEL_SENHA = SENHA;
    process.env.PAINEL_SEGREDO = "segredo-longo-o-bastante-para-assinar";
  });

  it("diz que não há sessão antes de entrar", async () => {
    const r = await chamar("/api/sessao");
    expect(r.codigo).toBe(200);
    expect(r.corpo).toEqual({ entrou: false });
  });

  it("recusa rota protegida sem cookie", async () => {
    for (const rota of ["/api/config", "/api/conversas", "/api/metricas"]) {
      expect((await chamar(rota)).codigo).toBe(401);
    }
  });

  it("recusa senha errada", async () => {
    const r = await chamar("/api/entrar", { metodo: "POST", corpo: { senha: "errada" } });
    expect(r.codigo).toBe(401);
    expect(r.cabecalhos["Set-Cookie"]).toBeUndefined();
  });

  it("entrega cookie de sessão para a senha certa", async () => {
    const r = await chamar("/api/entrar", { metodo: "POST", corpo: { senha: SENHA } });

    expect(r.codigo).toBe(200);
    const cookie = r.cabecalhos["Set-Cookie"]!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // Sem `Secure` o cookie viaja em texto claro se alguém abrir por http.
    expect(cookie).toContain("Secure");
  });

  it("aceita rota protegida com o cookie recebido", async () => {
    const entrada = await chamar("/api/entrar", { metodo: "POST", corpo: { senha: SENHA } });
    const cookie = entrada.cabecalhos["Set-Cookie"]!.split(";")[0]!;

    const sessao = await chamar("/api/sessao", { cookie });
    expect(sessao.corpo).toEqual({ entrou: true });
  });

  it("não aceita cookie adulterado", async () => {
    const entrada = await chamar("/api/entrar", { metodo: "POST", corpo: { senha: SENHA } });
    const cookie = entrada.cabecalhos["Set-Cookie"]!.split(";")[0]!;

    // Troca o último caractere da assinatura.
    const adulterado = cookie.slice(0, -1) + (cookie.at(-1) === "a" ? "b" : "a");
    expect((await chamar("/api/config", { cookie: adulterado })).codigo).toBe(401);
  });

  it("sair devolve cookie que apaga a sessão", async () => {
    const r = await chamar("/api/sair", { metodo: "POST" });
    expect(r.cabecalhos["Set-Cookie"]).toContain("Max-Age=0");
  });
});
