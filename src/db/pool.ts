import pg from "pg";

/**
 * O host do pooler é `pooler.supabase.com`, não `supabase.co` — por isso a
 * checagem é pelo prefixo `supabase.`, que cobre os dois. Errar isso derruba
 * a conexão com "no encryption" só em produção.
 */
export function criarPool(databaseUrl: string): pg.Pool {
  const ehSupabase = databaseUrl.includes("supabase.");
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    ssl: ehSupabase ? { rejectUnauthorized: false } : undefined,
  });
}
