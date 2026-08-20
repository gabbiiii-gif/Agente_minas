-- Limiar do operador % do pg_trgm. Calibrado na Task 10 contra o golden set.
alter database postgres set pg_trgm.similarity_threshold = 0.25;

create or replace function agente.buscar_peca(
  p_texto_norm text,
  p_codigo     text default null,
  p_moto_id    uuid default null
) returns table (
  id                 uuid,
  codigo             text,
  descricao          text,
  unidade            text,
  estoque            int,
  fitment            text,
  dias_sem_atualizar int,
  score              real
) language sql stable as $$
  select p.id,
         p.codigo,
         p.descricao,
         p.unidade,
         p.estoque,
         coalesce(pm.origem, 'nenhum')::text as fitment,
         extract(day from now() - p.atualizado_em)::int as dias_sem_atualizar,
         greatest(
           case
             when p_codigo is not null and p.codigo = p_codigo           then 1.0
             when p_codigo is not null and p.codigo like p_codigo || '%' then 0.9
             else 0
           end,
           similarity(p.descricao_norm, p_texto_norm)
         )::real as score
  from agente.produtos p
  left join agente.produto_moto pm
         on pm.produto_id = p.id
        and pm.moto_id = p_moto_id
  where p.ativo
    and (
      (p_codigo is not null and p.codigo like p_codigo || '%')
      or p.descricao_norm % p_texto_norm
    )
  order by (pm.origem = 'humano') desc nulls last,
           (pm.origem is not null) desc,
           score desc,
           p.estoque desc
  limit 8;
$$;
