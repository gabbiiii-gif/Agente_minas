/** Sufixos que o WhatsApp usa e que não são conversa de cliente. */
const NAO_E_PESSOA = /@g\.us$|@broadcast$|^status@/i;

/**
 * Reduz qualquer forma de telefone à chave usada em `agente.contatos`:
 * dígitos, com código do país, sem "+".
 *
 * O Evolution manda `5593999998888@s.whatsapp.net`, o dono digita
 * `(93) 99999-8888`, e os dois precisam virar a mesma linha na tabela —
 * senão o mesmo cliente vira dois contatos e o histórico se parte.
 *
 * Devolve null para grupo, status e lixo. É assim que o gateway descarta o
 * que não é atendimento, então null aqui significa "ignore esta mensagem".
 */
export function normalizarTelefone(bruto: string): string | null {
  if (bruto === "" || NAO_E_PESSOA.test(bruto)) return null;

  const digitos = bruto.replace(/\D/g, "");
  if (digitos.length < 10) return null;

  // Número local (DDD + 8 ou 9 dígitos) ganha o 55 do Brasil. A loja é de
  // Altamira e não atende de fora; se um dia atender, isto muda aqui.
  const comPais = digitos.length <= 11 ? `55${digitos}` : digitos;

  // 55 + DDD(2) + 8 ou 9 dígitos
  if (!/^55\d{10,11}$/.test(comPais)) return null;
  return comPais;
}
