import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { criarPool } from "../../src/db/pool.js";
import { aplicarMigracoes } from "../../src/db/migrar.js";

const url = process.env.TEST_DATABASE_URL;
const descrever = url ? describe : describe.skip;

descrever("schema agente", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = criarPool(url!);
    await aplicarMigracoes(pool, "supabase/migrations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("cria todas as tabelas previstas", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'agente'",
    );
    const nomes = rows.map((r) => r.table_name);
    for (const esperada of [
      "produtos", "motos", "produto_moto", "sinonimos",
      "contatos", "conversas", "mensagens", "demanda_nao_atendida",
      "config", "saidas_pendentes",
      "servicos", "agente_versoes", "painel_log",
    ]) {
      expect(nomes).toContain(esperada);
    }
  });

  it("guarda preço só onde o balcão o consulta", async () => {
    // O preço passou a existir para o balcão ler no painel, e não para o
    // agente falar. Por isso a proibição deixou de ser "não existe preço" e
    // virou "existe em dois lugares, e só neles".
    //
    // agente.config é um par chave/valor de configuração — o "valor" ali é o
    // conteúdo jsonb da chave, não dinheiro.
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'agente'
         and (column_name ilike '%preco%' or column_name ilike '%valor%')
         and not (table_name = 'config' and column_name = 'valor')
       order by table_name, column_name`,
    );

    expect(rows).toEqual([
      { table_name: "produtos", column_name: "preco_atualizado_em" },
      { table_name: "produtos", column_name: "preco_centavos" },
      { table_name: "servicos", column_name: "preco_centavos" },
    ]);
  });

  it("não entrega preço pela função que o agente consulta", async () => {
    // Esta é a trava que importa. O agente só enxerga o catálogo por
    // `buscar_peca`, e quem decide o que ele enxerga é a lista de colunas de
    // retorno dela — não o prompt, que é editável pelo painel. Enquanto
    // `preco` não estiver aqui, nem instrução adulterada faz o modelo dizer
    // um valor: o dado nunca chega até ele.
    const { rows } = await pool.query<{ colunas: string }>(
      `select pg_get_function_result(p.oid) as colunas
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'agente' and p.proname = 'buscar_peca'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.colunas).not.toMatch(/preco/i);
  });

  it("habilita pg_trgm e unaccent", async () => {
    const { rows } = await pool.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('pg_trgm','unaccent')",
    );
    expect(rows.map((r) => r.extname).sort()).toEqual(["pg_trgm", "unaccent"]);
  });
});
