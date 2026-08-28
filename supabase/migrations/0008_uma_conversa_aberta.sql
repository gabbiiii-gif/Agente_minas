-- Uma conversa aberta por contato, garantido pelo banco.
--
-- O índice já existia em produção, criado à mão quando o painel passou a
-- mostrar conversa duplicada. Aqui ele entra no controle de versão: banco
-- novo (ou restaurado de dump) nasceria sem ele, e a regra voltaria a valer
-- só "por combinação" — que é como ela foi quebrada da primeira vez.
--
-- Parcial de propósito: conversa encerrada pode se acumular à vontade, é
-- histórico. O que não pode é duas abertas ao mesmo tempo, porque aí metade
-- das mensagens do cliente cai numa e metade na outra.
create unique index if not exists conversas_uma_aberta_por_contato
  on agente.conversas (contato_id)
  where status <> 'encerrada';
