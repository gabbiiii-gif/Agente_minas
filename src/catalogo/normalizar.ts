const ACENTOS = /[̀-ͯ]/g;
const PONTUACAO = /[.,;:!?()[\]{}"'`\\/|+*_]/g;
const ESPACOS = /\s+/g;

/**
 * Forma canônica usada tanto na descrição do ERP quanto na frase do cliente.
 * Caixa alta, sem acento, pontuação vira espaço. Dígitos e hífen ficam.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(ACENTOS, "")
    .toUpperCase()
    .replace(PONTUACAO, " ")
    .replace(ESPACOS, " ")
    .trim();
}
