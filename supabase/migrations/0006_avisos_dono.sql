-- O que o sistema manda para o telefone do dono, gravado.
--
-- Hoje saem duas coisas por ali: o relatório diário de demanda e o alerta de
-- falha no atendimento. Nenhuma das duas deixava rastro — se o dono dizia
-- "não chegou relatório ontem", não havia como saber se ele não foi enviado,
-- se foi enviado vazio, ou se o Evolution recusou. Cada linha aqui responde
-- essa pergunta.
create table if not exists agente.avisos_dono (
  id        bigserial primary key,
  tipo      text not null check (tipo in ('relatorio', 'alerta', 'manual', 'teste')),
  texto     text not null,
  -- Guardado junto: o número muda, e saber para onde foi na época importa
  -- mais do que saber para onde iria hoje.
  telefone  text,
  enviado   boolean not null default false,
  erro      text,
  criado_em timestamptz not null default now()
);

create index if not exists avisos_dono_recente on agente.avisos_dono (criado_em desc);

alter table agente.avisos_dono enable row level security;
