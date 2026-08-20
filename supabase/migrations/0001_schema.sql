create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create schema if not exists agente;

-- ---------- catálogo ----------
create table if not exists agente.produtos (
  id             uuid primary key default gen_random_uuid(),
  codigo         text unique not null,
  descricao      text not null,
  descricao_norm text not null,
  unidade        text,
  estoque        int  not null default 0,
  ativo          boolean not null default true,
  atualizado_em  timestamptz not null default now()
);

create table if not exists agente.motos (
  id         uuid primary key default gen_random_uuid(),
  marca      text not null,
  modelo     text not null,
  cilindrada int,
  ano_ini    int,
  ano_fim    int,
  apelidos   text[] not null default '{}',
  unique (marca, modelo, cilindrada, ano_ini)
);

create table if not exists agente.produto_moto (
  produto_id uuid not null references agente.produtos(id) on delete cascade,
  moto_id    uuid not null references agente.motos(id)    on delete cascade,
  origem     text not null check (origem in ('auto','humano')),
  confianca  real,
  primary key (produto_id, moto_id)
);

create table if not exists agente.sinonimos (
  termo    text primary key,
  canonico text not null
);

-- ---------- conversa (usado no plano seguinte) ----------
create table if not exists agente.contatos (
  id             uuid primary key default gen_random_uuid(),
  telefone       text unique not null,
  nome           text,
  moto_id        uuid references agente.motos(id),
  bairro         text,
  opt_in         boolean not null default true,
  silenciado_ate timestamptz,
  criado_em      timestamptz not null default now()
);

create table if not exists agente.conversas (
  id            uuid primary key default gen_random_uuid(),
  contato_id    uuid not null references agente.contatos(id) on delete cascade,
  status        text not null default 'ativa'
                check (status in ('ativa','aguardando_humano','encerrada')),
  intencao      text,
  desfecho      text,
  resumo        text,
  iniciada_em   timestamptz not null default now(),
  ultima_msg_em timestamptz not null default now()
);

create table if not exists agente.mensagens (
  id          bigserial primary key,
  conversa_id uuid not null references agente.conversas(id) on delete cascade,
  papel       text not null check (papel in ('cliente','agente','humano','sistema')),
  conteudo    text,
  tipo_midia  text not null default 'texto'
              check (tipo_midia in ('texto','imagem','audio')),
  midia_url   text,
  msg_ext_id  text unique,
  tokens_in   int,
  tokens_out  int,
  modelo      text,
  criado_em   timestamptz not null default now()
);

create table if not exists agente.demanda_nao_atendida (
  id          bigserial primary key,
  conversa_id uuid references agente.conversas(id) on delete set null,
  texto_bruto text not null,
  peca_norm   text,
  moto_id     uuid references agente.motos(id),
  motivo      text not null
              check (motivo in ('sem_estoque','nao_cadastrado','nao_trabalhamos')),
  criado_em   timestamptz not null default now()
);

create table if not exists agente.config (
  chave text primary key,
  valor jsonb not null
);

create table if not exists agente.saidas_pendentes (
  id         bigserial primary key,
  telefone   text not null,
  conteudo   text not null,
  tentativas int not null default 0,
  erro       text,
  criado_em  timestamptz not null default now()
);

-- ---------- índices ----------
create index if not exists produtos_descricao_norm_trgm
  on agente.produtos using gin (descricao_norm gin_trgm_ops);
create index if not exists produtos_codigo on agente.produtos (codigo);
create index if not exists motos_apelidos on agente.motos using gin (apelidos);
create index if not exists mensagens_conversa on agente.mensagens (conversa_id, criado_em desc);
create index if not exists demanda_recente on agente.demanda_nao_atendida (criado_em desc);

-- ---------- RLS: nada exposto ----------
-- O serviço acessa por conexão direta com o usuário postgres, não por PostgREST.
-- Ligar RLS sem policy garante que qualquer acesso via anon/authenticated seja negado.
alter table agente.produtos             enable row level security;
alter table agente.motos                enable row level security;
alter table agente.produto_moto         enable row level security;
alter table agente.sinonimos            enable row level security;
alter table agente.contatos             enable row level security;
alter table agente.conversas            enable row level security;
alter table agente.mensagens            enable row level security;
alter table agente.demanda_nao_atendida enable row level security;
alter table agente.config               enable row level security;
alter table agente.saidas_pendentes     enable row level security;
