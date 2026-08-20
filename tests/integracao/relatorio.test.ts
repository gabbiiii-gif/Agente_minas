import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";
import {
  levantarDemanda,
  montarTexto,
  enviarRelatorio,
} from "../../src/relatorio/diario.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

const EVOLUTION = { url: "http://evolution.teste", apiKey: "k", instancia: "minas" };
const DONO = "5593999999999";

descrever("relatório diário", () => {
  let pool: Pool;
  let motoId: string;
  let enviados: Array<{ number: string; text: string }>;

  const registrar = async (peca: string | null, comMoto: boolean, quantas = 1) => {
    for (let i = 0; i < quantas; i++) {
      await pool.query(
        `insert into agente.demanda_nao_atendida (texto_bruto, peca_norm, moto_id, motivo)
         values ($1, $2, $3, 'nao_cadastrado')`,
        [`pedido de ${peca ?? "algo"}`, peca, comMoto ? motoId : null],
      );
    }
  };

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
    await pool.query("delete from agente.demanda_nao_atendida");

    const { rows } = await pool.query<{ id: string }>(
      `insert into agente.motos (marca, modelo, cilindrada) values ('Honda','Biz',125)
       on conflict (marca, modelo, cilindrada, ano_ini) do update set marca = excluded.marca
       returning id`,
    );
    motoId = rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query("delete from agente.demanda_nao_atendida");
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("delete from agente.demanda_nao_atendida");
    enviados = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      enviados.push(JSON.parse(init.body as string));
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
  });

  it("agrupa por peça e moto, do mais pedido para o menos", async () => {
    await registrar("PASTILHA FREIO", true, 3);
    await registrar("RETENTOR DIANTEIRO", true, 1);

    const linhas = await levantarDemanda(pool);

    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({ peca: "PASTILHA FREIO", pedidos: 3 });
    expect(linhas[0]!.moto).toBe("Honda Biz 125");
    expect(linhas[1]!.pedidos).toBe(1);
  });

  it("ignora demanda mais velha que a janela", async () => {
    await registrar("CORRENTE", true, 1);
    await pool.query(
      "update agente.demanda_nao_atendida set criado_em = now() - interval '30 hours'",
    );

    expect(await levantarDemanda(pool, 24)).toHaveLength(0);
    expect(await levantarDemanda(pool, 48)).toHaveLength(1);
  });

  it("separa o mesmo pedido feito para motos diferentes", async () => {
    await registrar("PASTILHA FREIO", true, 2);
    await registrar("PASTILHA FREIO", false, 1);

    const linhas = await levantarDemanda(pool);

    // Duas linhas: a compra é diferente conforme a moto.
    expect(linhas).toHaveLength(2);
    expect(linhas.find((l) => l.moto === null)!.pedidos).toBe(1);
  });

  it("escreve a lista no formato que o dono lê no balcão", () => {
    const texto = montarTexto([
      { peca: "PASTILHA FREIO", moto: "Honda Biz 125", pedidos: 3 },
      { peca: null, moto: null, pedidos: 1 },
    ]);

    expect(texto).toContain("3× pastilha freio — Honda Biz 125");
    expect(texto).toContain("1× peça não identificada — moto não informada");
  });

  it("não monta texto nenhum quando não houve demanda", () => {
    // Relatório vazio todo dia treina o dono a ignorar a mensagem.
    expect(montarTexto([])).toBeNull();
  });

  it("não manda nada num dia sem demanda", async () => {
    const mandou = await enviarRelatorio(pool, EVOLUTION, DONO);

    expect(mandou).toBe(false);
    expect(enviados).toHaveLength(0);
  });

  it("manda para o dono e para mais ninguém", async () => {
    await registrar("PASTILHA FREIO", true, 2);

    const mandou = await enviarRelatorio(pool, EVOLUTION, DONO);

    expect(mandou).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.number).toBe(DONO);
    expect(enviados[0]!.text).toContain("pastilha freio");
  });

  it("chega numa mensagem só, por mais longa que a lista fique", async () => {
    // Peças distintas de propósito: se todas fossem iguais viravam uma linha
    // só e o texto ficaria curto, sem exercitar nada.
    for (let i = 0; i < 15; i++) await registrar(`PECA DE TESTE NUMERO ${i}`, true, 1);

    await enviarRelatorio(pool, EVOLUTION, DONO);

    // O relatório passa pelo mesmo `dividir` das respostas ao cliente. Uma
    // linha em branco no texto o partiria em duas mensagens.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.text.length).toBeGreaterThan(280);
  });

  it("não tenta enviar sem telefone do dono configurado", async () => {
    await registrar("PASTILHA FREIO", true, 1);

    expect(await enviarRelatorio(pool, EVOLUTION, null)).toBe(false);
    expect(enviados).toHaveLength(0);
  });
});
