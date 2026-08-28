-- Guarda o que a IA extraiu da descrição, não só o vínculo que saiu disso.
--
-- A extração ("desta descrição saem os modelos nxr/150 e biz/125") depende só
-- do texto da peça. O vínculo depende também da frota cadastrada — e a frota
-- muda: o seed de motos foi de 33 para 142 modelos, e a lista de apelidos vai
-- continuar sendo corrigida conforme o vocabulário real aparece nas conversas.
--
-- Sem esta coluna, cada correção no seed obriga a reprocessar o catálogo
-- inteiro na API (~US$ 3,40 e ~10 min) só para chegar num casamento que é
-- puro texto local. Com ela, recasar é uma query.
alter table agente.produtos
  add column if not exists modelos_extraidos jsonb;

-- Quem tem extração guardada pode ser recasado sem API. O índice parcial serve
-- exatamente essa varredura.
create index if not exists produtos_com_extracao
  on agente.produtos (id) where modelos_extraidos is not null;
