-- Configuração que o dono muda pelo painel, sem deploy.
--
-- `do nothing`, não `do update`: se o dono desligou o bot em produção, o
-- próximo deploy que rodar os seeds não pode religar sozinho.
insert into agente.config (chave, valor) values
  ('bot_ativo',                'true'::jsonb),
  ('horario_funcionamento',    '"Seg a Sex 8h-18h · Sáb 8h-12h"'::jsonb),
  ('endereco',                 '"Av. Tancredo Neves, 1200 — Altamira/PA"'::jsonb),
  ('teto_contatos_novos_hora', '12'::jsonb),
  ('max_mensagens_conversa',   '30'::jsonb)
on conflict (chave) do nothing;
