import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { lerEvento } from "../../src/gateway/payload.js";

const PASTA = "tests/unit/fixtures";
const fixture = (n: string) => JSON.parse(readFileSync(`${PASTA}/${n}.json`, "utf8"));

/**
 * Os três fixtures são payloads capturados da instância real (Task 1, Step 5):
 * uma mensagem de texto, uma foto com legenda e uma de grupo.
 *
 * Enquanto não existirem, este bloco fica pulado em vez de rodar contra um
 * payload inventado. O envelope do Evolution muda entre versões, e teste
 * escrito contra payload imaginado passa enquanto a produção quebra — daí
 * pular ser mais honesto do que inventar. Basta pôr os arquivos em
 * `tests/unit/fixtures/` que estes testes voltam a rodar sozinhos.
 */
const temFixtures = ["texto", "imagem", "grupo"].every((n) =>
  existsSync(`${PASTA}/${n}.json`),
);
const comFixture = temFixtures ? describe : describe.skip;

comFixture("lerEvento — contra payload real do Evolution", () => {
  it("lê mensagem de texto de cliente", () => {
    const r = lerEvento(fixture("texto"));
    expect(r).toMatchObject({ tipo: "texto", fromMe: false });
    if ("tipo" in r) {
      expect(r.telefone).toMatch(/^55\d{10,11}$/);
      expect(r.msgExtId.length).toBeGreaterThan(0);
    }
  });

  it("lê foto com legenda", () => {
    const r = lerEvento(fixture("imagem"));
    expect(r).toMatchObject({ tipo: "imagem" });
    if ("tipo" in r && r.tipo === "imagem") {
      expect(r.midiaBase64.length).toBeGreaterThan(100);
      expect(r.mimetype).toMatch(/^image\//);
    }
  });

  it("descarta mensagem de grupo", () => {
    expect(lerEvento(fixture("grupo"))).toEqual({ descartar: "grupo" });
  });
});

/** Envelope mínimo, para cada teste dizer só o que está exercitando. */
const evento = (message: unknown, extra: Record<string, unknown> = {}) => ({
  event: "messages.upsert",
  data: {
    key: { remoteJid: "5593999998888@s.whatsapp.net", id: "X", fromMe: false },
    message,
    ...extra,
  },
});

describe("lerEvento — descartes e casos de borda", () => {
  it("descarta evento que não é mensagem", () => {
    expect(lerEvento({ event: "connection.update", data: {} })).toEqual({
      descartar: "evento ignorado: connection.update",
    });
  });

  it("descarta corpo vazio", () => {
    expect(lerEvento(evento({}))).toEqual({ descartar: "sem conteúdo tratável" });
  });

  it("descarta áudio, que a v1 não trata", () => {
    expect(
      lerEvento(evento({ audioMessage: { seconds: 3 } }, { messageType: "audioMessage" })),
    ).toEqual({ descartar: "audio" });
  });

  it("descarta grupo pelo sufixo do jid", () => {
    const emGrupo = {
      event: "messages.upsert",
      data: {
        key: { remoteJid: "12036304212345678@g.us", id: "X", fromMe: false },
        message: { conversation: "oi" },
      },
    };
    expect(lerEvento(emGrupo)).toEqual({ descartar: "grupo" });
  });

  it("descarta imagem sem base64, apontando a configuração que falta", () => {
    const r = lerEvento(evento({ imageMessage: { mimetype: "image/jpeg" } }));
    expect(r).toHaveProperty("descartar");
    expect((r as { descartar: string }).descartar).toContain("webhookBase64");
  });

  it("marca fromMe sem descartar — o gateway precisa saber para silenciar", () => {
    const r = lerEvento({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "5593999998888@s.whatsapp.net", id: "Y", fromMe: true },
        message: { conversation: "já separo" },
        messageType: "conversation",
      },
    });
    expect(r).toMatchObject({ fromMe: true, tipo: "texto", texto: "já separo" });
  });

  it("lê texto de resposta citada (extendedTextMessage)", () => {
    const r = lerEvento(evento({ extendedTextMessage: { text: "e a pastilha?" } }));
    expect(r).toMatchObject({ tipo: "texto", texto: "e a pastilha?" });
  });

  it("descarta lixo sem explodir", () => {
    // Webhook que lança faz o Evolution reenviar em laço.
    expect(lerEvento(null)).toHaveProperty("descartar");
    expect(lerEvento("x")).toHaveProperty("descartar");
    expect(lerEvento({})).toHaveProperty("descartar");
  });
});
