// Conversa com o agente pelo terminal, sem WhatsApp.
//
// Serve para ver o atendimento funcionando contra o catálogo real antes de
// existir VPS e Evolution API. Usa exatamente o mesmo prompt, as mesmas
// ferramentas e o mesmo laço que a produção vai usar — o que muda é só de
// onde vem o texto do cliente e para onde vai a resposta.
import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { criarPool } from "../db/pool.js";
import { lerEnv } from "../config/env.js";
import { montarPrompt } from "./prompt.js";
import { responder, type Fala } from "./laco.js";
import { executarFerramenta } from "../ferramentas/executar.js";

const env = lerEnv();
const pool = criarPool(env.databaseUrl);
const anthropic = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 });

const prompt = montarPrompt({
  agora: new Date(),
  horario: "Seg a Sex 8h-18h · Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
  nome: null,
  moto: null,
});

// Conversa de teste não grava em `conversas`: sem id, as ferramentas que
// escrevem apenas registram demanda solta, sem sujar o funil de métricas.
const ctx = { conversaId: null, contatoId: null };

const historico: Fala[] = [];
const io = createInterface({ input: process.stdin, output: process.stdout });

console.log("\n=== MINAS AUTO PEÇAS — atendimento de teste ===");
console.log("Escreva como um cliente escreveria. Ctrl+C para sair.\n");

let totalIn = 0;
let totalOut = 0;

try {
  for (;;) {
    const linha = (await io.question("cliente> ")).trim();
    if (linha === "") continue;
    if (linha === "/sair") break;

    historico.push({ papel: "cliente", conteudo: linha });

    const turno = await responder(
      {
        anthropic,
        prompt,
        executar: (nome, entrada) => executarFerramenta(pool, ctx, nome, entrada),
        aoUsarFerramenta: (nome, entrada, resultado) => {
          console.log(`  · ${nome}(${JSON.stringify(entrada)})`);
          console.log(`    → ${JSON.stringify(resultado)}`);
        },
      },
      historico,
    );

    totalIn += turno.tokensIn;
    totalOut += turno.tokensOut;

    console.log(`\nagente> ${turno.texto}\n`);
    historico.push({ papel: "agente", conteudo: turno.texto });

    if (turno.handoff) {
      console.log(`[HANDOFF: ${turno.handoff.motivo}]`);
      console.log(`[resumo para o balcão: ${turno.handoff.resumo}]\n`);
      break;
    }
  }
} finally {
  io.close();
  await pool.end();
  console.log(`\ntokens — entrada ${totalIn} · saída ${totalOut}`);
}
