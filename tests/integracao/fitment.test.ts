import { describe, expect, it } from "vitest";
import { extrairModelos } from "../../src/catalogo/fitment.js";

const chave = process.env.ANTHROPIC_API_KEY;
const descrever = chave ? describe : describe.skip;

/**
 * Conta como indisponibilidade da conta, não como defeito do código: sem
 * saldo ou sem credencial não dá para testar a extração, e falhar aqui
 * mandaria procurar bug onde não tem.
 */
function contaIndisponivel(erro: unknown): boolean {
  const msg = (erro as Error).message ?? "";
  return /credit balance|rate_limit|authentication|permission/i.test(msg);
}

descrever("extrairModelos", () => {
  it("extrai modelo e cilindrada de descrições reais do ERP", async ({ skip }) => {
    let mapa: Map<string, Array<{ modelo: string; cilindrada: number | null }>>;
    try {
      mapa = await extrairModelos(
        [
          "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA",
          "RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA",
          "FITA VEDA ROSCA 12/10  MAX PARTS",
        ],
        chave!,
        true,
      );
    } catch (erro) {
      if (contaIndisponivel(erro)) {
        console.warn(
          `PULADO — API Anthropic indisponível para a conta: ${(erro as Error).message.slice(0, 120)}`,
        );
        skip();
        return;
      }
      throw erro;
    }

    expect(mapa.get("ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA"))
      .toEqual([{ modelo: "titan", cilindrada: 150 }]);

    const multi = mapa.get("RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA") ?? [];
    expect(multi.map((m) => m.modelo).sort()).toEqual(["cbx", "nx", "titan", "xr"]);

    expect(mapa.get("FITA VEDA ROSCA 12/10  MAX PARTS")).toEqual([]);
  }, 60_000);
});
