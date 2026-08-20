import { describe, expect, it } from "vitest";
import { extrairModelos } from "../../src/catalogo/fitment.js";

const chave = process.env.ANTHROPIC_API_KEY;
const descrever = chave ? describe : describe.skip;

descrever("extrairModelos", () => {
  it("extrai modelo e cilindrada de descrições reais do ERP", async () => {
    const mapa = await extrairModelos(
      [
        "ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA",
        "RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA",
        "FITA VEDA ROSCA 12/10  MAX PARTS",
      ],
      chave!,
    );

    expect(mapa.get("ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA"))
      .toEqual([{ modelo: "titan", cilindrada: 150 }]);

    const multi = mapa.get("RETENTOR CUBO DIANT. XR/NX/CBX/TITAN ES HONDA") ?? [];
    expect(multi.map((m) => m.modelo).sort()).toEqual(["cbx", "nx", "titan", "xr"]);

    expect(mapa.get("FITA VEDA ROSCA 12/10  MAX PARTS")).toEqual([]);
  }, 60_000);
});
