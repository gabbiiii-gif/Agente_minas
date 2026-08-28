-- Separa o fitment que a descrição afirma do fitment que a regra deduziu.
--
-- Até aqui `origem` tinha dois valores: 'humano' (o balcão conferiu, e só ele
-- autorizava o agente a dizer "serve na sua moto") e 'auto' (extração da IA,
-- que o agente sempre hedgeava). Na prática 'auto' misturava duas coisas bem
-- diferentes:
--
--   "PISTAO SPEED150 C/ANEIS"  -> speed 150   a descrição DIZ a cilindrada
--   "DESCANSO LATERAL XT/TDM225" -> tenere 600  a regra ESPALHOU o modelo sem
--                                               número para todas as cilindradas
--
-- O segundo caso é o que gera devolução e frete. O primeiro é confiável: o ERP
-- escreveu o número e ele bate.
--
-- 'auto_exato' é o primeiro caso. O agente pode afirmar compatibilidade nele,
-- como faz com 'humano'. Mas continua NÃO sendo 'humano', de propósito:
--   - ninguém conferiu, e o dado não deve fingir que sim;
--   - `--recasar` apaga e refaz 'auto' e 'auto_exato', nunca 'humano'. Assim a
--     promoção se reconstrói sozinha a cada recasamento, e a confirmação de
--     gente sobrevive a todas elas.
alter table agente.produto_moto
  drop constraint if exists produto_moto_origem_check;

alter table agente.produto_moto
  add constraint produto_moto_origem_check
  check (origem in ('auto','auto_exato','humano'));
