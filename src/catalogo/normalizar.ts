const ACENTOS = /[̀-ͯ]/g;
const PONTUACAO = /[.,;:!?()[\]{}"'`\\/|+*_]/g;
const ESPACOS = /\s+/g;

// O ERP gruda modelo e cilindrada ("TITAN150", "BIZ125") e o cliente escreve
// separado ("titan 150"). Sem cortar aqui, os dois vocabulários nunca casam:
// foi a maior fonte de erro de busca na calibração do golden set.
const LETRA_DIGITO = /([A-Z])(\d)/g;
const DIGITO_LETRA = /(\d)([A-Z])/g;

/**
 * Forma canônica usada tanto na descrição do ERP quanto na frase do cliente.
 *
 * O que faz, nesta ordem:
 *   1. tira acento ("óleo" -> "OLEO");
 *   2. põe em caixa alta;
 *   3. troca pontuação por espaço, o que separa modelos colados por barra
 *      ("XR/NX/CBX" -> "XR NX CBX");
 *   4. separa letra de dígito ("TITAN150" -> "TITAN 150");
 *   5. colapsa espaço repetido.
 *
 * Dígitos e hífen sobrevivem porque medida de pneu ("90/90-19") é parte do
 * nome da peça. Precisa rodar nos DOIS lados da busca — se divergir entre
 * catálogo e consulta, a busca não acha nada.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(ACENTOS, "")
    .toUpperCase()
    .replace(PONTUACAO, " ")
    .replace(LETRA_DIGITO, "$1 $2")
    .replace(DIGITO_LETRA, "$1 $2")
    .replace(ESPACOS, " ")
    .trim();
}
