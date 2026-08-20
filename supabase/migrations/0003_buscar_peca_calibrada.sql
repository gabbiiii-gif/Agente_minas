-- Busca calibrada contra o golden set (Task 10).
--
-- A versão anterior (0002) usava só similarity() e ficava em recall@3 82,5%:
-- similarity divide pelos trigramas da união, então descrição longa do ERP
-- ("CORRENTE TRANS. 520H-104L XR250/XRE300 AUTOTEC") sempre perdia para
-- descrição curta que casava por acaso. Três correções mediram +17,5 pontos:
--
--   1. cobertura de tokens  — quantas palavras da consulta aparecem na
--      descrição. É o que um atendente faz: confere palavra por palavra.
--   2. strict_word_similarity — casa palavra inteira, tolerando erro de
--      digitação; melhor que similarity para consulta curta em texto longo.
--   3. bônus de tipo de peça — o ERP nomeia a peça pelo tipo primeiro
--      ("ESCAPE TITAN150"), então descrição que COMEÇA com a primeira palavra
--      da consulta é quase sempre a peça certa. Sem isso "PROTETOR ESCAPE"
--      e "GUIA CORRENTE" ganhavam de "ESCAPE" e "CORRENTE".
--
-- Resultado no golden set: recall@1 87,5% · recall@3 100%.

create or replace function agente.buscar_peca(
  p_texto_norm text,   -- consulta já normalizada e expandida pelo TypeScript
  p_codigo     text default null,  -- preenchido só quando o cliente manda código
  p_moto_id    uuid default null   -- usado para ordenar por compatibilidade
) returns table (
  id                 uuid,
  codigo             text,
  descricao          text,
  unidade            text,
  estoque            int,
  fitment            text,
  dias_sem_atualizar int,
  score              real
) language sql stable
-- Limiares presos à função, não à sessão. `alter database ... set` não
-- funciona aqui: o shared pooler do Supabase reaproveita conexões e elas
-- carregam o valor de quando foram abertas — os limiares silenciosamente
-- voltavam ao padrão 0.6/0.25 em produção. Preso na função, vale sempre.
-- Mais baixo que isto começa a devolver lixo: a 0.12 a consulta-controle
-- "geladeira brastemp duplex" passou a retornar peça de moto.
set pg_trgm.similarity_threshold = 0.20
set pg_trgm.word_similarity_threshold = 0.50
as $$
  with consulta as (
    select string_to_array(p_texto_norm, ' ') as tokens,
           split_part(p_texto_norm, ' ', 1)   as tipo
  )
  select p.id,
         p.codigo,
         p.descricao,
         p.unidade,
         p.estoque,
         -- 'humano' = balcão confirmou que serve; 'auto' = extraído por IA e
         -- vale só como pista de ordenação; 'nenhum' = não mapeado.
         coalesce(pm.origem, 'nenhum')::text as fitment,
         extract(day from now() - p.atualizado_em)::int as dias_sem_atualizar,
         greatest(
           -- código bate: resposta exata, não precisa de texto
           case
             when p_codigo is not null and p.codigo = p_codigo           then 1.0
             when p_codigo is not null and p.codigo like p_codigo || '%' then 0.9
             else 0
           end,
           -- metade cobertura de palavra, metade semelhança tolerante a erro
           ( cardinality(array(
               select unnest(c.tokens)
               intersect
               select unnest(string_to_array(p.descricao_norm, ' '))
             ))::real / greatest(cardinality(c.tokens), 1) ) * 0.5
           + strict_word_similarity(p_texto_norm, p.descricao_norm) * 0.5
           + case when p.descricao_norm like c.tipo || '%' then 0.15 else 0 end
         )::real as score
  from agente.produtos p
  cross join consulta c
  left join agente.produto_moto pm
         on pm.produto_id = p.id
        and pm.moto_id = p_moto_id
  where p.ativo
    and (
      (p_codigo is not null and p.codigo like p_codigo || '%')
      or p_texto_norm <% p.descricao_norm
      or p.descricao_norm % p_texto_norm
    )
  -- fitment ordena, nunca filtra: lacuna na extração automática não pode
  -- virar um "não tenho" falso.
  order by (pm.origem = 'humano') desc nulls last,
           (pm.origem is not null) desc,
           score desc,
           p.estoque desc
  limit 8;
$$;
