export {}; // sem import, o TS nao trata o arquivo como modulo e recusa top-level await

// Diz se o WhatsApp está conectado. Útil para conferir sem abrir o painel.
const URL_BASE = process.env.EVOLUTION_URL ?? "http://localhost:8080";
const CHAVE = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCIA = process.env.EVOLUTION_INSTANCIA ?? "minas";

const r = await fetch(`${URL_BASE}/instance/connectionState/${INSTANCIA}`, {
  headers: { apikey: CHAVE },
});
const corpo = await r.json().catch(() => ({}));
const estado = (corpo as any)?.instance?.state ?? (corpo as any)?.state ?? "sem instância";

console.log(`instância "${INSTANCIA}": ${estado}`);
console.log(
  estado === "open"
    ? "  conectado — pronto para receber mensagem"
    : "  não conectado — rode: npm run whatsapp:parear",
);
