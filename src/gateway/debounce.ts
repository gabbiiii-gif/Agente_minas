export interface Debounce {
  registrar(chave: string): void;
  pendentes(): number;
  encerrar(): void;
}

/**
 * Junta mensagens picadas num turno só.
 *
 * Cliente escreve como fala: "boa tarde", "tem retentor", "pra titan 160" em
 * três mensagens seguidas. Cada nova mensagem reinicia a contagem; quando o
 * cliente para de digitar por `esperaMs`, o turno dispara com tudo junto.
 * Sem isso o agente responde três vezes e atropela a própria conversa.
 *
 * Vive em memória de propósito: se o processo cair, a janela se perde e o
 * cliente reenvia — mais simples do que uma fila persistente para 8 segundos.
 */
export function criarDebounce(
  esperaMs: number,
  aoDisparar: (chave: string) => void,
): Debounce {
  const timers = new Map<string, NodeJS.Timeout>();

  /**
   * Roda o turno sem deixar a falha escapar.
   *
   * Exceção dentro de `setTimeout` é uncaught no Node e derruba o processo
   * inteiro; promessa rejeitada de um `aoDisparar` assíncrono tem o mesmo
   * efeito. O gateway fica ligado o tempo todo, então um turno que falha não
   * pode tirar o atendimento do ar para todo mundo — registra e segue.
   */
  function disparar(chave: string): void {
    try {
      const resultado = aoDisparar(chave) as unknown;
      if (resultado instanceof Promise) {
        resultado.catch((erro) => console.error(`debounce: turno ${chave} falhou`, erro));
      }
    } catch (erro) {
      console.error(`debounce: turno ${chave} falhou`, erro);
    }
  }

  return {
    registrar(chave: string): void {
      const anterior = timers.get(chave);
      if (anterior !== undefined) clearTimeout(anterior);

      timers.set(
        chave,
        setTimeout(() => {
          // Apaga antes de disparar: o turno pode demorar, e mensagem que
          // chegar durante ele precisa abrir uma janela nova, não reiniciar
          // uma que já venceu.
          timers.delete(chave);
          disparar(chave);
        }, esperaMs),
      );
    },

    pendentes: () => timers.size,

    encerrar(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
