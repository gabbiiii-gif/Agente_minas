// Suíte de aceite rodando DENTRO do Supabase.
//
// Existe porque a chave da Anthropic do `.env` da máquina foi revogada, e a
// que funciona vive nos segredos deste projeto — segredo do Supabase não se
// lê de volta, então em vez de trazer a chave para cá, levamos o teste para lá.
//
// Um caso por invocação (`?caso=3`): as 13 conversas somadas passariam do
// tempo de parede da função, e por caso ainda dá para ver qual falhou sem ler
// log nenhum.
//
//   npm run funcao:preparar
//   npx supabase functions deploy aceite --no-verify-jwt
//
// Isto NÃO é a suíte oficial — a de `tests/aceite/` continua sendo, e volta a
// rodar sozinha quando houver chave válida na máquina. Esta é a saída para
// verificar o prompt sem chave local, e pode ser apagada depois.
import { Pool as PoolDeno } from "jsr:@db/postgres@0.19";
import Anthropic from "npm:@anthropic-ai/sdk@0.120.0";
import { montarPrompt, montarContexto } from "../_shared/agente/prompt.ts";
import { responder, type Fala, type Imagem } from "../_shared/agente/laco.ts";
import { executarFerramenta } from "../_shared/ferramentas/executar.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const SEGREDO = env("WEBHOOK_SEGREDO");

const LOJA = {
  horario: "Seg a Sex 8h-18h · Sáb 8h-12h",
  endereco: "Av. Tancredo Neves, 1200 — Altamira/PA",
};

/** 1x1 PNG. Não dá para identificar peça nenhuma nele — e é esse o teste. */
const PNG_MINIMO =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const poolDeno = new PoolDeno(env("DATABASE_URL") || env("SUPABASE_DB_URL"), 3, true);

const pool = {
  async query(texto: string, params: unknown[] = []) {
    const c = await poolDeno.connect();
    try {
      const r = await c.queryObject({ text: texto, args: params });
      return { rows: r.rows as any[], rowCount: r.rowCount ?? r.rows.length };
    } finally {
      c.release();
    }
  },
} as any;

const anthropic = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY"), maxRetries: 2 });

const cliente = (conteudo: string): Fala => ({ papel: "cliente", conteudo });
const agente = (conteudo: string): Fala => ({ papel: "agente", conteudo });

interface Resultado {
  texto: string;
  usou: string[];
  chamadas: Array<{ nome: string; entrada: any; resultado: any }>;
}

/**
 * Roda um turno registrando o que o modelo pediu.
 *
 * Leitura vai ao catálogo de verdade — é o ponto do teste. Escrita é
 * interceptada: `registrar_demanda` rodando de verdade sujaria a lista de
 * compra do dono com peça inventada por teste.
 */
async function conversar(
  falas: Fala[],
  opcoes: { agora?: Date; nome?: string | null; foto?: Imagem } = {},
): Promise<Resultado> {
  const chamadas: Resultado["chamadas"] = [];

  const turno = await responder(
    {
      anthropic,
      prompt: montarPrompt(LOJA),
      contexto: montarContexto({
        agora: opcoes.agora ?? new Date(),
        nome: opcoes.nome ?? null,
        moto: null,
      }),
      executar: async (nome, entrada) => {
        const saida = await (async () => {
          if (nome === "buscar_peca" || nome === "identificar_moto") {
            return executarFerramenta(pool, { conversaId: null, contatoId: null }, nome, entrada);
          }
          if (nome === "transferir_humano") {
            const e = entrada as { motivo?: string; resumo?: string };
            return {
              resultado: { transferido: true },
              efeito: {
                tipo: "handoff" as const,
                motivo: String(e.motivo ?? "fora_escopo"),
                resumo: String(e.resumo ?? ""),
                origem: "ferramenta" as const,
              },
            };
          }
          return { resultado: { registrado: true } };
        })();
        chamadas.push({ nome, entrada, resultado: saida.resultado });
        return saida;
      },
    },
    falas,
    opcoes.foto,
  );

  return { texto: turno.texto, usou: chamadas.map((c) => c.nome), chamadas };
}

type Caso = { n: number; nome: string; rodar: () => Promise<string[]> };

/** Cada caso devolve a lista de falhas. Lista vazia = passou. */
const CASOS: Caso[] = [
  {
    n: 1,
    nome: "pergunta a cilindrada antes de buscar quando a moto está incompleta",
    async rodar() {
      const r = await conversar([cliente("tem retentor pra titam?")]);
      const f: string[] = [];
      if (r.usou.includes("buscar_peca")) f.push("buscou sem saber a cilindrada");
      if (!r.texto.includes("?")) f.push("não perguntou nada");
      return f;
    },
  },
  {
    n: 2,
    nome: "não fala preço e entrega ao balcão quando o cliente confirma a peça",
    async rodar() {
      const r = await conversar([
        cliente("quanto tá o kit relação da fan 160?"),
        agente("O valor quem te passa é o balcão. É a coroa e pinhão da Fan 160, código 3312?"),
        cliente("é essa mesma"),
      ]);
      const f: string[] = [];
      if (!r.usou.includes("transferir_humano")) f.push("não transferiu depois de confirmar");
      if (/R\$|\d+\s*reais/i.test(r.texto)) f.push("falou valor");
      return f;
    },
  },
  {
    n: 3,
    nome: "registra demanda quando a loja não tem a peça",
    async rodar() {
      const r = await conversar([cliente("vocês têm airbag pra titan 160?")]);
      const f: string[] = [];
      const busca = r.chamadas.find((c) => c.nome === "buscar_peca");
      if (busca && busca.resultado?.achados?.length > 0) {
        f.push("cenário velho: o catálogo passou a casar 'airbag'");
      }
      if (!r.usou.includes("registrar_demanda")) f.push("não registrou a demanda");
      return f;
    },
  },
  {
    n: 4,
    nome: "confirma o que viu na foto antes de buscar",
    async rodar() {
      const r = await conversar([cliente("é essa peça aqui, tem?")], {
        foto: { base64: PNG_MINIMO, mimetype: "image/png" },
      });
      const f: string[] = [];
      if (r.usou.includes("buscar_peca")) f.push("buscou a partir de foto ilegível");
      if (!r.texto.includes("?")) f.push("não pediu confirmação");
      return f;
    },
  },
  {
    n: 5,
    nome: "não faz contraproposta quando pedem desconto",
    async rodar() {
      const r = await conversar([
        cliente("tem pastilha de freio da biz 125?"),
        agente("Tem sim. Pastilha de freio Biz 125."),
        cliente("faz por 20?"),
      ]);
      const f: string[] = [];
      if (!r.usou.includes("transferir_humano")) f.push("não transferiu no pedido de desconto");
      if (/R\$|\d+\s*reais/i.test(r.texto)) f.push("falou valor");
      return f;
    },
  },
  {
    n: 6,
    nome: "passa reclamação de garantia direto para o balcão",
    async rodar() {
      const r = await conversar([cliente("comprei uma vela aqui ontem e já queimou")]);
      const f: string[] = [];
      const t = r.chamadas.find((c) => c.nome === "transferir_humano");
      if (!t) f.push("não transferiu a reclamação");
      else if (!/garantia|reclamacao/.test(String(t.entrada?.motivo))) {
        f.push(`motivo errado: ${t.entrada?.motivo}`);
      }
      return f;
    },
  },
  {
    n: 7,
    nome: "não afirma compatibilidade que o balcão não confirmou",
    async rodar() {
      const r = await conversar([
        cliente("tem coroa e pinhão pra fan 160?"),
        agente("Tem sim."),
        cliente("e serve certinho na minha? é 2019"),
      ]);
      const f: string[] = [];
      if (/serve certinho|com certeza serve|garanto que serve/i.test(r.texto)) {
        f.push("afirmou compatibilidade sem confirmação do balcão");
      }
      const busca = r.chamadas.find((c) => c.nome === "buscar_peca");
      const achou = (busca?.resultado?.achados?.length ?? 0) > 0;
      if (achou && /\bserve\b|\bcompatível\b/i.test(r.texto)) {
        if (!/confirm|confer|dá uma olhada|foto|antes de vir/i.test(r.texto)) {
          f.push("disse que serve sem pedir confirmação");
        }
      }
      return f;
    },
  },
  {
    n: 8,
    nome: "não diagnostica; oferece a oficina",
    async rodar() {
      const r = await conversar([cliente("minha moto tá falhando na subida, o que pode ser?")]);
      return /oficina|mecânic/i.test(r.texto) ? [] : ["não ofereceu a oficina"];
    },
  },
  {
    n: 9,
    nome: "responde ao conjunto das mensagens picadas, não só à última",
    async rodar() {
      const r = await conversar([
        cliente("boa tarde"),
        cliente("tem retentor"),
        cliente("pra titan"),
        cliente("160"),
      ]);
      const tratou = r.usou.includes("buscar_peca") || /retentor/i.test(r.texto);
      return tratou ? [] : ["respondeu só à última mensagem"];
    },
  },
  {
    n: 10,
    nome: "fora do horário responde, mas não promete separação",
    async rodar() {
      const r = await conversar([cliente("tem pastilha de freio da biz 125?")], {
        agora: new Date("2026-08-27T22:30:00-03:00"),
      });
      return /já separei|vou separar|deixo separad/i.test(r.texto)
        ? ["prometeu separação fora do horário"]
        : [];
    },
  },
  {
    n: 12,
    nome: "insistência no preço vira handoff, sem repetir desculpa",
    async rodar() {
      const r = await conversar([
        cliente("quanto custa o kit relação da fan 160?"),
        agente("O valor quem te passa é o balcão. É pra sua Fan 160, certo?"),
        cliente("sim, mas me fala o preço"),
      ]);
      const f: string[] = [];
      if (!r.usou.includes("transferir_humano")) f.push("não transferiu na insistência");
      if (/R\$|\d+\s*reais/i.test(r.texto)) f.push("falou valor");
      return f;
    },
  },
  {
    n: 13,
    nome: "não diz quantidade em estoque",
    async rodar() {
      const r = await conversar([
        cliente("tem pastilha de freio da biz 125?"),
        agente("Tem sim. Pastilha de freio Biz 125."),
        cliente("tem quantos aí?"),
      ]);
      return /\b\d+\s*(unidades?|peças?|pares?)\b|tenho \d+|resta[m]? \d+|só tem \d+/i.test(r.texto)
        ? ["disse quantidade"]
        : [];
    },
  },
  {
    n: 14,
    nome: "preço de peça que não achou vira handoff, sem pedir foto nem código",
    async rodar() {
      // O caso do Pedro: três peças e o valor do bloco. O agente pedia foto e
      // código, não chamava o balcão, e a venda morria ali.
      const r = await conversar([
        cliente("Rabeta /suporte de placa\nMesa superior\nBros 150 2013"),
        cliente("Valor do bloco ."),
      ]);
      const f: string[] = [];
      if (!r.usou.includes("transferir_humano")) f.push("não chamou o balcão");
      if (!r.usou.includes("registrar_demanda")) f.push("não registrou a demanda");
      if (/manda(r)? (uma )?foto|c[óo]digo da pe[çc]a/i.test(r.texto)) {
        f.push("pediu foto ou código a quem já perguntou preço");
      }
      if (/R\$|\d+\s*reais/i.test(r.texto)) f.push("falou valor");
      return f;
    },
  },
];

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (SEGREDO === "" || url.searchParams.get("token") !== SEGREDO) {
    return Response.json({ erro: "segredo inválido" }, { status: 401 });
  }

  const n = Number(url.searchParams.get("caso") ?? "0");
  const caso = CASOS.find((c) => c.n === n);
  if (!caso) {
    return Response.json({ casos: CASOS.map((c) => ({ n: c.n, nome: c.nome })) });
  }

  const comeco = Date.now();
  try {
    const falhas = await caso.rodar();
    return Response.json({
      caso: caso.n,
      nome: caso.nome,
      passou: falhas.length === 0,
      falhas,
      ms: Date.now() - comeco,
    });
  } catch (erro) {
    return Response.json({
      caso: caso.n,
      nome: caso.nome,
      passou: false,
      falhas: [`erro: ${(erro as Error).message}`],
      ms: Date.now() - comeco,
    });
  }
});
