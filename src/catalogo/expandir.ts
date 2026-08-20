export type Sinonimos = ReadonlyMap<string, string>;

/**
 * Substitui termos por sua forma canônica em uma única passagem da esquerda
 * para a direita, sempre casando a frase mais longa possível. A saída não é
 * reprocessada, então um canônico que contém o próprio termo é seguro.
 *
 * @param textoNorm texto já passado por `normalizar`
 */
export function expandir(textoNorm: string, sinonimos: Sinonimos): string {
  if (sinonimos.size === 0) return textoNorm;

  const tokens = textoNorm.split(" ").filter((t) => t !== "");
  const maiorFrase = Math.max(
    ...[...sinonimos.keys()].map((chave) => chave.split(" ").length),
  );

  const saida: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    let casou = false;
    const limite = Math.min(maiorFrase, tokens.length - i);

    for (let n = limite; n >= 1; n--) {
      const frase = tokens.slice(i, i + n).join(" ");
      const canonico = sinonimos.get(frase);
      if (canonico !== undefined) {
        saida.push(canonico);
        i += n;
        casou = true;
        break;
      }
    }

    if (!casou) {
      saida.push(tokens[i]!);
      i += 1;
    }
  }

  return saida.join(" ");
}
