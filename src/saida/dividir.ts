/**
 * Quebra a resposta em mensagens de WhatsApp.
 *
 * Parede de texto denuncia bot e cansa quem lê no celular. Quebra primeiro em
 * parágrafo, depois em fim de frase.
 *
 * `max` é alvo de legibilidade, não limite do protocolo — o WhatsApp aceita
 * muito mais. Por isso a frase é a menor unidade que se preserva inteira: uma
 * frase que passa um pouco do alvo vai sozinha na parte, em vez de chegar
 * cortada no meio ao cliente. Só palavra maior que `max` (link, código longo)
 * é fatiada, e aí não há alternativa que não seja entrar em laço.
 */
export function dividir(texto: string, max = 280): string[] {
  const limpo = texto.trim();
  if (limpo === "") return [];

  const partes: string[] = [];

  for (const paragrafo of limpo.split(/\n{2,}/)) {
    const p = paragrafo.trim();
    if (p === "") continue;

    if (p.length <= max) {
      partes.push(p);
      continue;
    }

    // Parágrafo grande: junta frases até encher a parte.
    let atual = "";

    for (const frase of p.split(/(?<=[.!?])\s+/)) {
      if (frase.length > max) {
        if (atual !== "") {
          partes.push(atual.trim());
          atual = "";
        }

        // Frase comprida mas sem palavra gigante vai inteira: cortá-la só
        // porque passou do alvo entregaria meia frase ao cliente.
        const temPalavraGigante = frase.split(/\s+/).some((palavra) => palavra.length > max);
        if (!temPalavraGigante) {
          partes.push(frase.trim());
          continue;
        }

        // Última saída: fatia dura, para não repetir para sempre.
        for (let i = 0; i < frase.length; i += max) partes.push(frase.slice(i, i + max));
        continue;
      }

      if ((atual + " " + frase).trim().length > max) {
        partes.push(atual.trim());
        atual = frase;
      } else {
        atual = (atual + " " + frase).trim();
      }
    }

    if (atual.trim() !== "") partes.push(atual.trim());
  }

  return partes.filter((p) => p !== "");
}
