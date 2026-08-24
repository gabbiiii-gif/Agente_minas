-- Painel ganha três poderes que o dono não tinha: mexer no catálogo à mão,
-- guardar preço de peça e de serviço, e trocar a versão do agente sabendo
-- para onde voltar se a nova piorar o atendimento.

-- ---------- preço de peça ----------
-- Em centavos e inteiro: `real`/`float` arredonda dinheiro e vira reclamação
-- de balcão. Nulo é o estado normal — o ERP não exporta valor, então a
-- maioria das linhas nasce sem preço e só ganha um quando alguém digita.
alter table agente.produtos
  add column if not exists preco_centavos int
    check (preco_centavos is null or preco_centavos >= 0);

-- Quem digitou o preço à mão no painel não pode ter o valor apagado pelo
-- próximo import do ERP — a planilha não tem essa coluna para devolver.
alter table agente.produtos
  add column if not exists preco_atualizado_em timestamptz;

-- Marca a linha que nasceu no painel, não na planilha. O import usa isso
-- para não desativar produto que o dono cadastrou à mão só porque ele não
-- aparece no arquivo do ERP.
alter table agente.produtos
  add column if not exists origem text not null default 'erp'
    check (origem in ('erp', 'painel'));

-- ---------- serviços da oficina ----------
-- Peça vem do ERP; serviço não vem de lugar nenhum — troca de óleo, revisão
-- e ajuste de freio só existem na cabeça do dono. Esta tabela é a primeira
-- vez que eles ficam escritos.
create table if not exists agente.servicos (
  id             uuid primary key default gen_random_uuid(),
  nome           text not null,
  nome_norm      text not null,
  descricao      text,
  preco_centavos int check (preco_centavos is null or preco_centavos >= 0),
  duracao_min    int check (duracao_min is null or duracao_min > 0),
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

create unique index if not exists servicos_nome_norm on agente.servicos (nome_norm);
create index if not exists servicos_nome_trgm
  on agente.servicos using gin (nome_norm gin_trgm_ops);

-- ---------- versões do agente ----------
-- Toda publicação do painel vira uma linha aqui: modelo, instruções e um
-- bilhete de quem publicou. Trocar a versão do agente é copiar uma linha
-- destas de volta para `agente.config` — por isso o texto fica guardado
-- inteiro, e não como diff.
create table if not exists agente.agente_versoes (
  id            bigserial primary key,
  numero        int not null,
  modelo        text not null,
  prompt        text,
  nota          text,
  publicada_em  timestamptz not null default now(),
  publicada_por text not null default 'painel'
);

create unique index if not exists agente_versoes_numero on agente.agente_versoes (numero);
create index if not exists agente_versoes_recente on agente.agente_versoes (publicada_em desc);

-- ---------- log do painel ----------
-- Quem desligou o bot às 3 da tarde? Sem registro, a resposta some. Cada
-- ação destrutiva do painel deixa uma linha aqui.
create table if not exists agente.painel_log (
  id        bigserial primary key,
  acao      text not null,
  detalhe   jsonb,
  criado_em timestamptz not null default now()
);

create index if not exists painel_log_recente on agente.painel_log (criado_em desc);

-- ---------- RLS: nada exposto ----------
-- Mesma regra do 0001: o serviço entra por conexão direta, então ligar RLS
-- sem policy nenhuma nega qualquer acesso vindo do PostgREST.
alter table agente.servicos       enable row level security;
alter table agente.agente_versoes enable row level security;
alter table agente.painel_log     enable row level security;
