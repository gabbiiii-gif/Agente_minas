// Cria a instância no Evolution e mostra o QR code para parear o WhatsApp.
//
// Roda quantas vezes precisar: se a instância já existe, só pede um QR novo.
// O QR expira em cerca de 40 segundos e o Evolution gera outro sozinho — por
// isso o script fica acompanhando o estado até conectar.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const URL_BASE = process.env.EVOLUTION_URL ?? "http://localhost:8080";
const CHAVE = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCIA = process.env.EVOLUTION_INSTANCIA ?? "minas";

if (CHAVE === "") {
  console.error("EVOLUTION_API_KEY não está no .env");
  process.exit(1);
}

const cabecalhos = { apikey: CHAVE, "Content-Type": "application/json" };

async function api(caminho: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${URL_BASE}${caminho}`, { ...init, headers: cabecalhos });
  const texto = await r.text();
  try {
    return { status: r.status, corpo: JSON.parse(texto) };
  } catch {
    return { status: r.status, corpo: texto };
  }
}

async function estado(): Promise<string> {
  const { corpo } = await api(`/instance/connectionState/${INSTANCIA}`);
  return corpo?.instance?.state ?? corpo?.state ?? "desconhecido";
}

/** Abre o arquivo no navegador padrão do Windows. */
function abrirNoNavegador(caminho: string): void {
  spawn("cmd", ["/c", "start", "", caminho], { detached: true, stdio: "ignore" }).unref();
}

function paginaQr(base64: string): string {
  const src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Parear WhatsApp — Minas Auto Peças</title>
<meta http-equiv="refresh" content="35">
<style>
  body{font:16px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#e6edf3;
       display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}
  .cx{max-width:460px;padding:28px}
  img{width:300px;height:300px;background:#fff;padding:14px;border-radius:12px}
  h1{font-size:20px;margin:0 0 6px} p{color:#8d96a0;font-size:14px}
  ol{text-align:left;font-size:14px;color:#c9d1d9;line-height:1.9}
</style></head><body><div class="cx">
<h1>Leia com o WhatsApp da loja</h1>
<p>Esta página se atualiza sozinha a cada 35 segundos — o QR expira rápido.</p>
<img src="${src}" alt="QR code">
<ol>
  <li>Abra o WhatsApp no celular da loja</li>
  <li>Toque nos três pontos → <b>Dispositivos conectados</b></li>
  <li>Toque em <b>Conectar dispositivo</b></li>
  <li>Aponte a câmera para este código</li>
</ol>
</div></body></html>`;
}

// A instância pode já existir de uma tentativa anterior; criar de novo devolve
// 403 e isso não é erro — só significa "já está lá".
const criacao = await api("/instance/create", {
  method: "POST",
  body: JSON.stringify({
    instanceName: INSTANCIA,
    integration: "WHATSAPP-BAILEYS",
    qrcode: true,
  }),
});

if (criacao.status >= 400 && !JSON.stringify(criacao.corpo).includes("already in use")) {
  console.error("Falha ao criar instância:", JSON.stringify(criacao.corpo).slice(0, 300));
  process.exit(1);
}

const jaConectado = await estado();
if (jaConectado === "open") {
  console.log(`A instância "${INSTANCIA}" já está conectada. Nada a fazer.`);
  process.exit(0);
}

let qr: string | undefined =
  criacao.corpo?.qrcode?.base64 ?? criacao.corpo?.base64;

if (!qr) {
  const conexao = await api(`/instance/connect/${INSTANCIA}`);
  qr = conexao.corpo?.base64 ?? conexao.corpo?.qrcode?.base64;
}

if (!qr) {
  console.error("O Evolution não devolveu QR code. Estado atual:", await estado());
  process.exit(1);
}

const arquivo = join(tmpdir(), `qr-${INSTANCIA}.html`);
writeFileSync(arquivo, paginaQr(qr), "utf8");
abrirNoNavegador(arquivo);

console.log("\nQR code aberto no navegador. Leia com o WhatsApp da loja.");
console.log("Esperando o pareamento (Ctrl+C para desistir)...\n");

// Acompanha até conectar. A cada 35s regrava a página com um QR novo, porque
// o anterior já expirou e a página recarrega sozinha.
const ATE = Date.now() + 5 * 60_000;
let ultimo = "";

while (Date.now() < ATE) {
  await new Promise((r) => setTimeout(r, 5000));
  const agora = await estado();

  if (agora !== ultimo) {
    console.log(`  estado: ${agora}`);
    ultimo = agora;
  }

  if (agora === "open") {
    console.log("\nWhatsApp conectado.");
    process.exit(0);
  }

  if (Date.now() % 35_000 < 5000) {
    const novo = await api(`/instance/connect/${INSTANCIA}`);
    const b64 = novo.corpo?.base64 ?? novo.corpo?.qrcode?.base64;
    if (b64) writeFileSync(arquivo, paginaQr(b64), "utf8");
  }
}

console.log("\nTempo esgotado sem parear. Rode de novo quando estiver com o celular em mãos.");
process.exit(1);
