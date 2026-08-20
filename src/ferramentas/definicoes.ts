import type Anthropic from "@anthropic-ai/sdk";

/**
 * As cinco ferramentas expostas ao modelo.
 *
 * A descrição de cada uma é prompt: é o que o modelo lê para decidir quando
 * chamar. Mudança aqui muda comportamento, então mexer exige rodar os testes
 * de aceite antes de subir.
 */
export const DEFINICOES: Anthropic.Tool[] = [
  {
    name: "identificar_moto",
    description:
      "Resolve texto livre do cliente para uma moto do cadastro. Use antes de buscar peça. Aceita apelido e erro de digitação ('titam 160', 'cg 160', 'fan 125').",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "ex: 'titam 160 2019', 'fan 125'" },
      },
      required: ["texto"],
    },
  },
  {
    name: "buscar_peca",
    description:
      "Busca no catálogo da loja. Único meio autorizado de afirmar que a loja tem uma peça. Devolve até três opções com código e descrição, se tem ou não, e a compatibilidade. NÃO devolve preço nem quantidade — esses dados não existem para você.",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "a peça como o cliente descreveu" },
        moto_id: {
          type: "string",
          description: "id devolvido por identificar_moto, quando houver",
        },
      },
      required: ["texto"],
    },
  },
  {
    name: "registrar_demanda",
    description:
      "Obrigatório sempre que a peça não for encontrada ou não estiver disponível. É o que vira lista de compra do dono.",
    input_schema: {
      type: "object",
      properties: {
        texto_bruto: { type: "string", description: "o que o cliente escreveu, sem tratamento" },
        peca_norm: { type: "string", description: "a peça em nome padronizado" },
        moto_id: { type: "string" },
        motivo: {
          type: "string",
          enum: ["sem_estoque", "nao_cadastrado", "nao_trabalhamos"],
        },
      },
      required: ["texto_bruto", "motivo"],
    },
  },
  {
    name: "abrir_servico",
    description:
      "Registra pedido de serviço na oficina. Não informe valor de mão de obra nem prazo.",
    input_schema: {
      type: "object",
      properties: {
        moto_id: { type: "string" },
        problema: { type: "string" },
        preferencia: { type: "string", description: "dia ou turno que o cliente prefere" },
      },
      required: ["problema"],
    },
  },
  {
    name: "transferir_humano",
    description:
      "Encerra o atendimento automático e chama o balcão. O resumo é o produto principal deste atendimento: escreva para o atendente agir sem reler a conversa.",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: [
            "preco", "desconto", "reclamacao", "garantia",
            "pedido_humano", "revenda", "ambiguidade", "fora_escopo",
          ],
        },
        resumo: {
          type: "string",
          description: "ex: 'Fan 160 2019 — retentor dianteiro — cód. 4402 — falta passar o valor'",
        },
      },
      required: ["motivo", "resumo"],
    },
  },
];
