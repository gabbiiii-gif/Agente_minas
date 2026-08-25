-- A foto que o cliente manda, guardada.
--
-- Até aqui a imagem chegava em base64, ia para o modelo dentro do turno e era
-- descartada. O balcão via "foto" escrito no painel e não via a foto — e foto
-- de peça velha é justamente o que resolve a dúvida de compatibilidade que o
-- agente não consegue fechar sozinho.
--
-- Os bytes ficam no Postgres, e não num bucket de storage, porque o volume não
-- justifica outro serviço: o histórico inteiro tem 37 imagens, e foto de
-- WhatsApp tem uns 150 KB. Um bucket traria chave nova, política de acesso e
-- mais uma coisa para configurar errado. Se um dia o volume crescer, a saída
-- é apagar o que é velho — ver o índice por data abaixo.
create table if not exists agente.midias (
  id          uuid primary key default gen_random_uuid(),
  mensagem_id bigint not null references agente.mensagens(id) on delete cascade,
  mime        text not null,
  bytes       bytea not null,
  tamanho     int not null,
  criado_em   timestamptz not null default now()
);

-- Uma mídia por mensagem: a foto é a mensagem, não um anexo dela.
create unique index if not exists midias_mensagem on agente.midias (mensagem_id);

-- Para a limpeza do que é velho sair barata quando fizer falta:
--   delete from agente.midias where criado_em < now() - interval '180 days';
create index if not exists midias_recente on agente.midias (criado_em desc);

alter table agente.midias enable row level security;
