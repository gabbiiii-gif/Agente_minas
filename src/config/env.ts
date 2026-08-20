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

/** O que o gateway do WhatsApp precisa, além do básico. */
export interface EnvGateway extends Env {
  evolutionUrl: string;
  evolutionApiKey: string;
  evolutionInstancia: string;
  webhookSegredo: string;
  porta: number;
  /** null quando não configurado: o gateway sobe, só não alerta ninguém. */
  telefoneDono: string | null;
}

/**
 * Lê a configuração do gateway.
 *
 * Separado de `lerEnv` de propósito: os CLIs de catálogo e de conversa rodam
 * na máquina do desenvolvedor e não têm Evolution nenhum. Exigir essas
 * variáveis lá quebraria o import de produtos por nada.
 */
export function lerEnvGateway(fonte: Fonte = process.env): EnvGateway {
  const porta = Number(fonte.PORTA ?? 3000);
  if (!Number.isInteger(porta) || porta <= 0) {
    throw new Error(`PORTA inválida: ${fonte.PORTA}`);
  }

  return {
    ...lerEnv(fonte),
    evolutionUrl: obrigatoria(fonte, "EVOLUTION_URL"),
    evolutionApiKey: obrigatoria(fonte, "EVOLUTION_API_KEY"),
    // A instância tem padrão porque é a mesma desde o pareamento; as outras
    // não podem ter, porque errar em silêncio significa webhook aberto.
    evolutionInstancia: fonte.EVOLUTION_INSTANCIA?.trim() || "minas",
    webhookSegredo: obrigatoria(fonte, "WEBHOOK_SEGREDO"),
    porta,
    telefoneDono: fonte.TELEFONE_DONO?.trim() || null,
  };
}
