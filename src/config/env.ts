/** Variáveis que o serviço precisa para subir. */
export interface Env {
  databaseUrl: string;
  anthropicApiKey: string;
}

type Fonte = Record<string, string | undefined>;

/**
 * Lê uma variável obrigatória e falha alto se faltar. Errar de vez, no
 * arranque, é melhor que descobrir a variável ausente no meio de um import
 * de 5.232 produtos.
 */
function obrigatoria(fonte: Fonte, chave: string): string {
  const valor = fonte[chave];
  if (valor === undefined || valor.trim() === "") {
    throw new Error(`Variável de ambiente ausente: ${chave}`);
  }
  return valor;
}

/**
 * Lê a configuração do ambiente.
 *
 * Recebe a fonte por parâmetro (em vez de ler `process.env` direto) para que
 * o teste unitário não precise mexer no ambiente do processo.
 */
export function lerEnv(fonte: Fonte = process.env): Env {
  return {
    databaseUrl: obrigatoria(fonte, "DATABASE_URL"),
    anthropicApiKey: obrigatoria(fonte, "ANTHROPIC_API_KEY"),
  };
}
