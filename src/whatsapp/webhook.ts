// Aponta o webhook do Evolution para o gateway, e confere que gravou.
//
//   npm run whatsapp:webhook -- https://seu-endereco/webhook
//
// Existe como script, e não como curl no README, por dois motivos. O envelope
// mudou entre versões do Evolution — v1 usava `webhookBase64`/`webhookByEvents`
// no formato plano, v2 quer tudo aninhado em `webhook` — e mandar o formato
// errado grava a URL mas descarta os headers em silêncio, o que faz o gateway
// recusar todo webhook com 401 sem ninguém entender por quê. E o segredo
// precisa ir no header, que é fácil de esquecer digitando à mão.
export {};

const URL_BASE = (process.env.EVOLUTION_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const CHAVE = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCIA = process.env.EVOLUTION_INSTANCIA ?? "minas";
const SEGREDO = process.env.WEBHOOK_SEGREDO ?? "";
const NOME_HEADER = "x-webhook-segredo";

const destino = process.argv[2] ?? process.env.WEBHOOK_URL ?? "";

function erro(msg: string): never {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (CHAVE === "") erro("EVOLUTION_API_KEY não está no .env");
if (destino === "") {
  erro("Falta a URL do gateway.\n  npm run whatsapp:webhook -- https://seu-endereco/webhook");
}

// Sem segredo o webhook fica aberto para qualquer um na internet mandar
// mensagem em nome de um cliente. Melhor não configurar do que configurar assim.
if (SEGREDO === "") erro("WEBHOOK_SEGREDO não está no .env. Sem ele o webhook ficaria aberto.");

// localhost só funciona se o Evolution rodar na mesma máquina que o gateway.
// Num Evolution hospedado isso aponta para dentro do próprio servidor dele, e
// a mensagem some sem erro nenhum.
if (/localhost|127\.0\.0\.1/.test(destino) && !/localhost|127\.0\.0\.1/.test(URL_BASE)) {
  erro(
    `A URL do gateway é ${destino}, mas o Evolution está em ${URL_BASE}.\n` +
      "Um servidor remoto não alcança o seu localhost — use o endereço público do gateway ou um túnel.",
  );
}

const cabecalhos = { apikey: CHAVE, "Content-Type": "application/json" };

async function api(caminho: string, init?: RequestInit): Promise<{ status: number; corpo: any }> {
  const r = await fetch(`${URL_BASE}${caminho}`, { ...init, headers: cabecalhos });
  const texto = await r.text();
  try {
    return { status: r.status, corpo: JSON.parse(texto) };
  } catch {
    return { status: r.status, corpo: texto };
  }
}

console.log(`\nEvolution:  ${URL_BASE}`);
console.log(`Instância:  ${INSTANCIA}`);
console.log(`Gateway:    ${destino}\n`);

const gravacao = await api(`/webhook/set/${INSTANCIA}`, {
  method: "POST",
  body: JSON.stringify({
    webhook: {
      enabled: true,
      url: destino,
      headers: { [NOME_HEADER]: SEGREDO },
      // byEvents false: tudo cai numa URL só, que é o que o gateway espera.
      byEvents: false,
      // base64 true é obrigatório para foto. Sem isso vem só a URL
      // criptografada do WhatsApp, que não dá para baixar sem as chaves da
      // sessão — o gateway descarta e o cliente fica sem resposta.
      base64: true,
      events: ["MESSAGES_UPSERT"],
    },
  }),
});

if (gravacao.status >= 400) {
  erro(`O Evolution recusou (HTTP ${gravacao.status}): ${JSON.stringify(gravacao.corpo).slice(0, 400)}`);
}

// Conferir não é paranoia: é aqui que o formato errado aparece. O set devolve
// 200 mesmo quando ignora campo que não conhece.
const conferencia = await api(`/webhook/find/${INSTANCIA}`);
const w = conferencia.corpo?.webhook ?? conferencia.corpo ?? {};
const headersGravados = w.headers ?? {};

const ok = {
  ligado: w.enabled === true,
  url: w.url === destino,
  segredo: headersGravados[NOME_HEADER] === SEGREDO,
  base64: w.base64 === true || w.webhookBase64 === true,
  evento: JSON.stringify(w.events ?? []).includes("MESSAGES_UPSERT"),
};

const marca = (b: boolean) => (b ? "ok  " : "FALHOU");
console.log(`${marca(ok.ligado)} webhook ligado`);
console.log(`${marca(ok.url)} url = ${w.url ?? "(vazia)"}`);
console.log(`${marca(ok.segredo)} header ${NOME_HEADER} gravado`);
console.log(`${marca(ok.base64)} base64 ligado (foto)`);
console.log(`${marca(ok.evento)} evento MESSAGES_UPSERT`);

if (!Object.values(ok).every(Boolean)) {
  erro(
    "O Evolution aceitou a requisição mas não gravou tudo.\n" +
      "Costuma ser diferença de versão no formato do corpo — confira em /manager.",
  );
}

console.log("\nWebhook configurado. Mande uma mensagem de teste e acompanhe o log do gateway.\n");
