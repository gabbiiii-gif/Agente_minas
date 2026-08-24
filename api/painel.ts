// Painel na Vercel: uma função só, roteando à mão.
//
// Toda a lógica vem de `src/painel/` — as mesmas funções que o Fastify local
// usa. O que existe aqui é tradução de HTTP: ler o caminho, conferir a sessão
// e devolver JSON.
//
// Uma função e não uma por rota porque serverless cobra por invocação fria:
// vinte arquivos seriam vinte bundles e vinte partidas a frio para uma tela
// que carrega tudo de uma vez.
//
// O arquivo se chamava `[...rota].ts`, apostando no roteamento automático da
// Vercel para caminhos aninhados. Não funcionava: com `outputDirectory`
// apontando para uma pasta estática, só `/api/algo` chegava aqui —
// `/api/conversas/<id>` batia no 404 estático e a tela recebia a página de
// erro em HTML onde esperava JSON ("Unexpected token 'T'"). Agora quem manda
// tudo para cá é o rewrite declarado no `vercel.json`, e o nome do arquivo
// deixou de importar.
import {
  obterPool,
  obterAnthropic,
  acaoLerConfig,
  acaoGravarConfig,
  acaoListarConversas,
  acaoLerConversa,
  acaoAlternarIa,
  acaoAlternarIaEmLote,
  acaoResponderManual,
  acaoMetricas,
  acaoDemandas,
  acaoSaidasPresas,
  acaoTestar,
} from "../src/painel/acoes.js";
import {
  listarProdutos,
  salvarProduto,
  desativarProduto,
  motosDoProduto,
  confirmarFitment,
  listarMotos,
  listarServicos,
  salvarServico,
  excluirServico,
  prever,
} from "../src/painel/catalogo.js";
import {
  listarVersoes,
  restaurarVersao,
  compararVersao,
  listarLog,
} from "../src/painel/versoes.js";
import { situacao, pedirQr, desconectar, reiniciar } from "../src/painel/whatsapp.js";
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

/**
 * Os segmentos do caminho pedido, sem o "api".
 *
 * O rewrite da Vercel é interno e a função continua vendo a URL original, mas
 * a leitura não depende disso: se um dia o caminho chegar já reescrito, o
 * `rota` da query cobre. Uma rota que some é a tela inteira quebrando, e o
 * custo de olhar dois lugares é uma comparação.
 */
function segmentos(req: Req): string[] {
  const daQuery = req.query?.rota;
  if (Array.isArray(daQuery) && daQuery.length > 0) return daQuery;
  if (typeof daQuery === "string" && daQuery !== "") return daQuery.split("/").filter(Boolean);

  const partes = (req.url ?? "").split("?")[0]!.split("/").filter(Boolean);
  // ["api", "conversas", "<id>", "ia"] → tira o "api"
  return partes[0] === "api" ? partes.slice(1) : partes;
}

export default async function handler(req: Req, resp: Resp): Promise<void> {
  const rota = segmentos(req);
  const raiz = rota[0] ?? "";
  const metodo = (req.method ?? "GET").toUpperCase();
  const cookie = primeiro(req.headers.cookie);

  /** Devolve o resultado, ou o código de erro que a ação pediu. */
  const ou = <T extends object>(r: T, codigo: number): void => {
    resp.status("erro" in r ? codigo : 200).json(r);
  };

  try {
    if (!LIVRES.has(raiz) && !sessaoValida(cookie)) {
      resp.status(401).json({ erro: "sessão expirada" });
      return;
    }

    const corpo = (req.body ?? {}) as Record<string, any>;

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

    // O WhatsApp fala com o Evolution, não com o banco — abrir pool aqui
    // seria conexão gasta à toa numa tela que o dono deixa aberta.
    if (raiz === "whatsapp") {
      const acao = rota[1];
      if (acao === undefined) {
        resp.status(200).json(await situacao());
        return;
      }
      if (acao === "qr" && metodo === "POST") {
        resp.status(200).json(await pedirQr());
        return;
      }
      if (acao === "desconectar" && metodo === "POST") {
        ou(await desconectar(), 400);
        return;
      }
      if (acao === "reiniciar" && metodo === "POST") {
        ou(await reiniciar(), 400);
        return;
      }
      resp.status(404).json({ erro: `rota desconhecida: ${rota.join("/")}` });
      return;
    }

    const pool = obterPool();

    if (raiz === "config") {
      if (metodo === "PUT") {
        ou(await acaoGravarConfig(pool, corpo as Partial<ConfigLoja>), 400);
        return;
      }
      resp.status(200).json(await acaoLerConfig(pool));
      return;
    }

    if (raiz === "metricas") {
      resp.status(200).json(await acaoMetricas(pool));
      return;
    }

    if (raiz === "demandas") {
      resp.status(200).json(await acaoDemandas(pool, Number(primeiro(req.query.dias)) || 30));
      return;
    }

    if (raiz === "saidas") {
      resp.status(200).json(await acaoSaidasPresas(pool));
      return;
    }

    if (raiz === "log") {
      resp.status(200).json(await listarLog(pool));
      return;
    }

    if (raiz === "conversas") {
      const id = rota[1];

      if (id === undefined) {
        resp.status(200).json(await acaoListarConversas(pool, primeiro(req.query.busca)));
        return;
      }

      // "lote" ocupa o lugar do id no caminho; nenhum uuid se parece com ele.
      if (id === "lote" && rota[2] === "ia" && metodo === "POST") {
        ou(await acaoAlternarIaEmLote(pool, corpo.ids, corpo.ativa === true), 400);
        return;
      }

      if (rota[2] === "ia" && metodo === "POST") {
        ou(await acaoAlternarIa(pool, id, corpo.ativa === true), 404);
        return;
      }

      if (rota[2] === "responder" && metodo === "POST") {
        ou(await acaoResponderManual(pool, id, String(corpo.texto ?? "")), 400);
        return;
      }

      ou(await acaoLerConversa(pool, id), 404);
      return;
    }

    if (raiz === "produtos") {
      const id = rota[1];

      if (id === undefined) {
        if (metodo === "POST") {
          ou(await salvarProduto(pool, corpo), 400);
          return;
        }
        resp.status(200).json(
          await listarProdutos(pool, {
            busca: primeiro(req.query.busca),
            filtro: primeiro(req.query.filtro) as any,
            pagina: Number(primeiro(req.query.pagina)) || 1,
          }),
        );
        return;
      }

      if (rota[2] === "ativo" && metodo === "POST") {
        ou(await desativarProduto(pool, id, corpo.ativo === true), 404);
        return;
      }

      if (rota[2] === "motos") {
        if (metodo === "POST") {
          ou(
            await confirmarFitment(pool, id, String(corpo.motoId ?? ""), corpo.confirmado !== false),
            400,
          );
          return;
        }
        resp.status(200).json(await motosDoProduto(pool, id));
        return;
      }

      if (metodo === "PUT") {
        ou(await salvarProduto(pool, { ...corpo, id }), 400);
        return;
      }

      resp.status(404).json({ erro: `rota desconhecida: ${rota.join("/")}` });
      return;
    }

    if (raiz === "motos") {
      resp.status(200).json(await listarMotos(pool, primeiro(req.query.busca)));
      return;
    }

    if (raiz === "prever" && metodo === "POST") {
      resp.status(200).json(await prever(pool, String(corpo.texto ?? "")));
      return;
    }

    if (raiz === "servicos") {
      const id = rota[1];

      if (id === undefined) {
        if (metodo === "POST") {
          ou(await salvarServico(pool, corpo), 400);
          return;
        }
        resp.status(200).json(await listarServicos(pool, primeiro(req.query.busca)));
        return;
      }

      if (metodo === "PUT") {
        ou(await salvarServico(pool, { ...corpo, id }), 400);
        return;
      }

      if (metodo === "DELETE") {
        ou(await excluirServico(pool, id), 404);
        return;
      }

      resp.status(404).json({ erro: `rota desconhecida: ${rota.join("/")}` });
      return;
    }

    if (raiz === "versoes") {
      if (rota[1] === "restaurar" && metodo === "POST") {
        ou(await restaurarVersao(pool, Number(corpo.numero)), 400);
        return;
      }
      if (rota[2] === "diff") {
        ou(await compararVersao(pool, Number(rota[1])), 404);
        return;
      }
      resp.status(200).json(await listarVersoes(pool));
      return;
    }

    if (raiz === "testar" && metodo === "POST") {
      ou(await acaoTestar(pool, obterAnthropic(), corpo), 400);
      return;
    }

    resp.status(404).json({ erro: `rota desconhecida: ${rota.join("/")}` });
  } catch (erro) {
    console.error("painel:", erro);
    resp.status(500).json({ erro: (erro as Error).message });
  }
}
