-- Marca quando um produto já passou pela extração de compatibilidade.
--
-- Sem isto, `catalogo:fitment` reprocessa o catálogo inteiro a cada execução.
-- Na primeira rodada real 8 dos 131 lotes falharam por saldo de API esgotado;
-- retomar significava pagar de novo pelos 123 que já tinham dado certo.
--
-- Marca também o produto que não casou com nenhuma moto (peça universal —
-- fita veda rosca, parafuso, óleo): ele foi processado, só não gerou vínculo,
-- e reprocessar não mudaria o resultado.
alter table agente.produtos
  add column if not exists fitment_em timestamptz;

-- Os produtos que já têm vínculo foram processados numa rodada anterior à
-- existência desta coluna.
update agente.produtos p
   set fitment_em = now()
 where fitment_em is null
   and exists (select 1 from agente.produto_moto pm where pm.produto_id = p.id);

create index if not exists produtos_sem_fitment
  on agente.produtos (id) where fitment_em is null;
