// Painel na Vercel: uma função só, roteando à mão.
//
// Toda a lógica vem de `src/painel/acoes.ts` — as mesmas funções que o
// Fastify local usa. O que existe aqui é tradução de HTTP: ler o caminho,
// conferir a sessão e devolver JSON.
//
// Uma função e não uma por rota porque serverless cobra por invocação fria:
// nove arquivos seriam nove bundles e nove partidas a frio para uma tela que
// carrega tudo de uma vez.
import {
  obterPool,
  obterAnthropic,
  acaoLerConfig,
  acaoGravarConfig,
  acaoListarConversas,
  acaoLerConversa,
  acaoAlternarIa,
  acaoMetricas,
  acaoTestar,
} from "../src/painel/acoes.js";
import { senhaConfere, criarCookie, cookieDeSaida, sessaoValida } from "../src/painel/auth.js";
import type { ConfigLoja } from "../src/config/loja.js";

/** O mínimo da requisição da Vercel que este arquivo usa. */
interface Req {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query: Record<string, string | string[] | undefined>;
}

interface Resp {
  status(codigo: number): Resp;
  json(corpo: unknown): void;
  setHeader(nome: string, valor: string): void;
}

/** Rotas que existem justamente para quem ainda não entrou. */
const LIVRES = new Set(["entrar", "sair", "sessao"]);

const primeiro = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

export default async function handler(req: Req, resp: Resp): Promise<void> {
  const partes = (req.url ?? "").split("?")[0]!.split("/").filter(Boolean);
  // ["api", "conversas", "<id>", "ia"] → tira o "api"
  const rota = partes[0] === "api" ? partes.slice(1) : partes;
  const raiz = rota[0] ?? "";
  const metodo = (req.method ?? "GET").toUpperCase();
  const cookie = primeiro(req.headers.cookie);

  try {
    if (!LIVRES.has(raiz) && !sessaoValida(cookie)) {
      resp.status(401).json({ erro: "sessão expirada" });
      return;
    }

    const corpo = (req.body ?? {}) as Record<string, unknown>;

    if (raiz === "sessao") {
      resp.status(200).json({ entrou: sessaoValida(cookie) });
      return;
    }

    if (raiz === "entrar" && metodo === "POST") {
      if (!senhaConfere(String(corpo.senha ?? ""))) {
        resp.status(401).json({ erro: "senha incorreta" });
        return;
      }
      resp.setHeader("Set-Cookie", criarCookie());
      resp.status(200).json({ ok: true });
      return;
    }

    if (raiz === "sair") {
      resp.setHeader("Set-Cookie", cookieDeSaida());
      resp.status(200).json({ ok: true });
      return;
    }

    const pool = obterPool();

    if (raiz === "config") {
      if (metodo === "PUT") {
        const r = await acaoGravarConfig(pool, corpo as Partial<ConfigLoja>);
        resp.status("erro" in r ? 400 : 200).json(r);
        return;
      }
      resp.status(200).json(await acaoLerConfig(pool));
      return;
    }

    if (raiz === "metricas") {
      resp.status(200).json(await acaoMetricas(pool));
      return;
    }

    if (raiz === "conversas") {
      const id = rota[1];

      if (id === undefined) {
        resp.status(200).json(await acaoListarConversas(pool, primeiro(req.query.busca)));
        return;
      }

      if (rota[2] === "ia" && metodo === "POST") {
        const r = await acaoAlternarIa(pool, id, corpo.ativa === true);
        resp.status("erro" in r ? 404 : 200).json(r);
        return;
      }

      const r = await acaoLerConversa(pool, id);
      resp.status("erro" in r ? 404 : 200).json(r);
      return;
    }

    if (raiz === "testar" && metodo === "POST") {
      const r = await acaoTestar(pool, obterAnthropic(), corpo);
      resp.status("erro" in r ? 400 : 200).json(r);
      return;
    }

    resp.status(404).json({ erro: `rota desconhecida: ${rota.join("/")}` });
  } catch (erro) {
    console.error("painel:", erro);
    resp.status(500).json({ erro: (erro as Error).message });
  }
}
