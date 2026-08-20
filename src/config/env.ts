export interface Env {
  databaseUrl: string;
  anthropicApiKey: string;
}

type Fonte = Record<string, string | undefined>;

function obrigatoria(fonte: Fonte, chave: string): string {
  const valor = fonte[chave];
  if (valor === undefined || valor.trim() === "") {
    throw new Error(`Variável de ambiente ausente: ${chave}`);
  }
  return valor;
}

export function lerEnv(fonte: Fonte = process.env): Env {
  return {
    databaseUrl: obrigatoria(fonte, "DATABASE_URL"),
    anthropicApiKey: obrigatoria(fonte, "ANTHROPIC_API_KEY"),
  };
}
