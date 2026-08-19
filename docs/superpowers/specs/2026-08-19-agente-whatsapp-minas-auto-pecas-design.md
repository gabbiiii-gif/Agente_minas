# Agente de atendimento WhatsApp — Minas Auto Peças

**Data:** 2026-08-19
**Empresa:** MINAS AUTO PECAS LTDA (filial 1) — Altamira/PA
**Status:** desenho aprovado, pronto para plano de implementação

---

## 1. Problema

A loja atende peças de moto e oficina pelo WhatsApp. Cada pedido começa com "boa tarde" e gasta três ou quatro trocas de mensagem só para o balcão descobrir qual moto o cliente tem e qual peça ele quer. O atendente que responde é o mesmo que atende o cliente presencial, então a fila do balcão sempre ganha e a conversa do WhatsApp esfria.

O agente resolve a parte mecânica dessa conversa: identifica a moto, identifica a peça, consulta o catálogo e entrega ao balcão um pedido já qualificado. O que ele não resolve — preço, desconto, garantia, reclamação — ele encaminha com o contexto pronto.

## 2. Decisões que moldam o desenho

Cinco restrições foram levantadas antes do desenho e definem tudo que vem depois.

**O ERP não exporta preço.** O relatório de estoque disponível (`RELATORIO ES.xlsx`) traz código, descrição, unidade, quantidade e data da última movimentação. Preço só existe na tela do sistema, produto a produto. **O agente, portanto, nunca fala preço.** Ele confirma qual peça existe e quantas há, e o valor fecha no balcão.

**O catálogo é grande e a descrição é boa.** 5.262 SKUs, 5.232 com estoque positivo. As descrições já carregam modelo e ano (`ESCAPE TITAN150 ESD 09 MOD. ORIG. CROMADA FORTUNA`, `VIDRO PAINEL BIZ125 09/10 VALPLAS/SMAT`). Isso permite extrair compatibilidade automaticamente, em vez de cadastrar na mão.

**O WhatsApp é o número principal da loja, via Evolution API.** Conexão não oficial, por QR code. O número tem histórico de anos e um banimento seria perda real, o que impõe limites de comportamento ao agente (seção 8).

**Bot e humano dividem o mesmo número.** Quando o balcão assume uma conversa, o agente precisa calar sozinho. Não há painel de atendimento na v1.

**Infraestrutura nova.** VPS nova para Evolution API e para o serviço do agente. Projeto Supabase novo, separado do MinasCaixa (livro-caixa da mesma loja).

### Consequência aceita: sem ligação com o MinasCaixa

O MinasCaixa roda em outro projeto Supabase e não tem tabela de produtos — ele registra venda por forma de pagamento, não por item. Com projetos separados, o agente não consegue ligar o contato do WhatsApp ao cliente do livro-caixa por chave estrangeira. O balcão não verá "esse cliente tem promissória em aberto" no momento do handoff.

Isso foi aceito para a v1. A tabela `contatos` guarda `telefone` normalizado, o que permite fazer essa ligação depois por consulta entre projetos, sem migração de dados.

## 3. Arquitetura

```
WhatsApp (número da loja)
     │
     ▼
VPS  (Docker Compose)
  ├─ evolution-api         sessão WhatsApp, webhook de saída
  ├─ postgres + redis      uso interno do Evolution
  └─ minas-agente          Node 20 + Fastify + TypeScript
        │
        ├──► Anthropic API   Claude Sonnet 5 (conversa) · Haiku (import)
        └──► Supabase        Postgres + Storage (projeto novo)
```

O serviço `minas-agente` é um processo Node sempre ligado. Não é serverless: o debounce de 8 segundos e o laço de tool-calling precisam de processo vivo, e a VPS já é obrigatória por causa do Evolution.

O importador de catálogo é um comando CLI do mesmo repositório, executado na máquina do desenvolvedor. Não roda na VPS.

Vercel está fora do escopo da v1. Se um painel web for construído depois, ele entra lá sem alterar nada deste desenho.

### Fora de escopo (v1)

Foram cortados deliberadamente:

- **Embeddings e busca vetorial.** Exigiriam um provedor de embeddings, geração de vetor por SKU e regeração a cada import. Para este catálogo, `pg_trgm` + `unaccent` + tabela de sinônimos cobrem o caso. A coluna `embedding` não é criada; entra por migração se o golden set (seção 9) mostrar falha por sinônimo que a tabela não resolve.
- **Pedido e reserva.** Sem preço não há total, e o fechamento acontece no balcão. A tool `criar_pedido` e a tabela `pedidos` ficam para a v2.
- **Painel web de atendimento.** O balcão responde pelo próprio WhatsApp.
- **Transcrição de áudio.** O agente pede texto ou foto. Whisper entra depois se o volume de áudio justificar.

## 4. Módulos

Oito módulos, cada um com uma responsabilidade e testável isoladamente.

| Módulo | Responsabilidade | Depende de |
|---|---|---|
| `gateway` | Recebe o webhook do Evolution. Descarta grupo, status e mensagem vazia. Garante idempotência por `msg_ext_id`. Detecta `fromMe` e silencia o bot. Aplica debounce. | Fastify, Supabase |
| `conversa` | Resolve contato por telefone, cria ou recupera conversa ativa, monta histórico das últimas 12 mensagens, controla status. | Supabase |
| `agente` | Laço de conversa com Claude Sonnet 5: monta contexto, executa tools, no máximo 5 iterações por turno. | Anthropic SDK |
| `ferramentas` | Implementa as 5 tools expostas ao modelo. | `busca`, Supabase |
| `busca` | RPC `buscar_peca`: código, sinônimos, trigram sobre descrição normalizada, ordenação por fitment. | Postgres |
| `saida` | Envia a resposta pelo Evolution: divide em partes de ~280 caracteres, aplica atrasos. | Evolution API |
| `catalogo` | CLI de import: lê o xlsx, normaliza descrição, faz upsert por código, extrai fitment com Haiku. | Haiku, Supabase |
| `relatorio` | Cron diário das 07h: demanda não atendida das últimas 24h, agrupada, enviada ao dono. | Supabase, Evolution |

Cada módulo é um diretório em `src/` com sua interface pública em `index.ts`. `gateway` não conhece `agente`; ele publica na fila interna. `agente` não conhece Evolution; ele devolve texto para `saida`. Isso permite testar o laço de conversa sem WhatsApp e testar a busca sem Claude.

## 5. Modelo de dados

Schema `agente` em projeto Supabase dedicado. Acesso apenas por `service_role` — não há cliente público, portanto RLS bloqueia tudo por padrão e o serviço usa a chave de serviço.

```sql
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

create schema if not exists agente;

-- ---------- catálogo ----------
create table agente.produtos (
  id             uuid primary key default gen_random_uuid(),
  codigo         text unique not null,
  descricao      text not null,          -- exatamente como vem do ERP
  descricao_norm text not null,          -- gerada no import: caixa alta, sem acento, abreviações expandidas
  unidade        text,                   -- UND | PAR | MT ...
  estoque        int  not null default 0,
  ativo          boolean not null default true,
  atualizado_em  timestamptz not null default now()
);

create table agente.motos (
  id         uuid primary key default gen_random_uuid(),
  marca      text not null,              -- honda | yamaha | shineray | dafra ...
  modelo     text not null,              -- titan | fan | biz | factor | bros | xre
  cilindrada int,
  ano_ini    int,
  ano_fim    int,
  apelidos   text[] not null default '{}',  -- {'titam','cg160','titan 160'}
  unique (marca, modelo, cilindrada, ano_ini)
);

create table agente.produto_moto (
  produto_id uuid references agente.produtos(id) on delete cascade,
  moto_id    uuid references agente.motos(id)    on delete cascade,
  origem     text not null check (origem in ('auto','humano')),
  confianca  real,                       -- preenchido só quando origem = 'auto'
  primary key (produto_id, moto_id)
);

create table agente.sinonimos (
  termo    text primary key,             -- normalizado
  canonico text not null                 -- normalizado
);

-- ---------- conversa ----------
create table agente.contatos (
  id             uuid primary key default gen_random_uuid(),
  telefone       text unique not null,   -- E.164
  nome           text,
  moto_id        uuid references agente.motos(id),
  bairro         text,
  opt_in         boolean not null default true,
  silenciado_ate timestamptz,            -- balcão assumiu; bot não responde até esta hora
  criado_em      timestamptz not null default now()
);

create table agente.conversas (
  id            uuid primary key default gen_random_uuid(),
  contato_id    uuid not null references agente.contatos(id) on delete cascade,
  status        text not null default 'ativa'
                check (status in ('ativa','aguardando_humano','encerrada')),
  intencao      text,   -- peca | servico_oficina | duvida | reclamacao | spam
  desfecho      text,   -- qualificou | sem_estoque | handoff | perdeu
  resumo        text,   -- texto entregue ao balcão no handoff
  iniciada_em   timestamptz not null default now(),
  ultima_msg_em timestamptz not null default now()
);

create table agente.mensagens (
  id          bigserial primary key,
  conversa_id uuid not null references agente.conversas(id) on delete cascade,
  papel       text not null check (papel in ('cliente','agente','humano','sistema')),
  conteudo    text,
  tipo_midia  text not null default 'texto' check (tipo_midia in ('texto','imagem','audio')),
  midia_url   text,
  msg_ext_id  text unique,               -- id do Evolution: idempotência
  tokens_in   int,
  tokens_out  int,
  modelo      text,
  criado_em   timestamptz not null default now()
);

-- ---------- o ativo de dados ----------
create table agente.demanda_nao_atendida (
  id          bigserial primary key,
  conversa_id uuid references agente.conversas(id) on delete set null,
  texto_bruto text not null,             -- o que o cliente escreveu, sem tratamento
  peca_norm   text,                      -- normalizado pelo agente
  moto_id     uuid references agente.motos(id),
  motivo      text not null check (motivo in ('sem_estoque','nao_cadastrado','nao_trabalhamos')),
  criado_em   timestamptz not null default now()
);

-- ---------- operação ----------
create table agente.config (
  chave text primary key,
  valor jsonb not null
);
-- linhas iniciais: bot_ativo, horario_funcionamento, endereco, teto_contatos_novos_hora

create table agente.saidas_pendentes (
  id          bigserial primary key,
  telefone    text not null,
  conteudo    text not null,
  tentativas  int not null default 0,
  erro        text,
  criado_em   timestamptz not null default now()
);

-- ---------- índices ----------
create index on agente.produtos using gin (descricao_norm gin_trgm_ops);
create index on agente.produtos (codigo);
create index on agente.produtos (ativo) where ativo;
create index on agente.motos using gin (apelidos);
create index on agente.mensagens (conversa_id, criado_em desc);
create index on agente.demanda_nao_atendida (criado_em desc);
```

### Normalização

Duas funções sustentam a busca. Ambas são determinísticas e cobertas por teste unitário.

`agente.normalizar(texto)` aplica, nesta ordem: `unaccent`, caixa alta, colapso de espaços, remoção de pontuação isolada.

`agente.expandir(texto)` substitui abreviações do ERP e termos de cliente por forma canônica, consultando `sinonimos`. Exemplos que precisam existir no seed inicial:

| Termo do ERP ou do cliente | Canônico |
|---|---|
| `DIANT` | `DIANTEIRO` |
| `TRAZ`, `TRAS` | `TRASEIRO` |
| `RET` | `RETENTOR` |
| `COROA E PINHAO` | `KIT RELACAO` |
| `TITAM` | `TITAN` |
| `PASTILHA` | `PASTILHA FREIO` |

`descricao_norm` é gravada no import como `expandir(normalizar(descricao))`. A consulta do cliente passa pelas mesmas duas funções antes de buscar. É isso que faz "retentor dianteiro" encontrar `RET DIANT`.

### Busca

```sql
create or replace function agente.buscar_peca(
  p_texto   text,
  p_moto_id uuid default null
) returns table (
  id uuid,
  codigo text,
  descricao text,
  unidade text,
  estoque int,
  fitment text,               -- 'humano' | 'auto' | 'nenhum'
  dias_sem_atualizar int,
  score real
) language sql stable as $$
  with q as (
    select agente.expandir(agente.normalizar(p_texto)) as texto_norm
  )
  select p.id,
         p.codigo,
         p.descricao,
         p.unidade,
         p.estoque,
         coalesce(pm.origem, 'nenhum') as fitment,
         extract(day from now() - p.atualizado_em)::int as dias_sem_atualizar,
         greatest(
           case
             when p.codigo = p_texto           then 1.0
             when p.codigo like p_texto || '%' then 0.9
             else 0
           end,
           similarity(p.descricao_norm, q.texto_norm)
         )::real as score
  from agente.produtos p
  cross join q
  left join agente.produto_moto pm
         on pm.produto_id = p.id
        and pm.moto_id = p_moto_id
  where p.ativo
    and (p.codigo like p_texto || '%'
         or p.descricao_norm % q.texto_norm)
  order by (pm.origem = 'humano') desc nulls last,
           (pm.origem is not null) desc,
           score desc
  limit 8;
$$;
```

O fitment ordena, não filtra. Peça compatível sobe ao topo, mas peça sem fitment mapeado continua aparecendo — caso contrário, uma lacuna na extração automática viraria um "não tenho" falso.

O limiar do operador `%` (`pg_trgm.similarity_threshold`) é calibrado em F2 contra o golden set, e o valor escolhido é fixado por migração.

## 6. Fluxo de uma mensagem

```
webhook Evolution
  ├─ grupo, status ou corpo vazio        → descarta
  ├─ msg_ext_id já gravado               → descarta (idempotência)
  ├─ fromMe = true                       → contatos.silenciado_ate = now() + 6h, descarta
  └─ segue
        ↓
  INSERT mensagens (papel = 'cliente')
        ↓
  silenciado_ate > now()                 → para (o balcão está no comando)
  conversas.status = 'aguardando_humano' → para
  config.bot_ativo = false               → para
        ↓
  debounce 8s
     └─ chegou mensagem nova nesse intervalo → para; o próximo turno responde tudo junto
        ↓
  monta contexto:
     system prompt + moto do contato + últimas 12 mensagens (+ imagem, se houver)
        ↓
  laço Claude, no máximo 5 iterações:
     tool_use → executa ferramenta → tool_result → repete até resposta em texto
        ↓
  divide em partes de ~280 caracteres
  atraso 2-4s antes da primeira parte, 1,2s entre partes
        ↓
  envia pelo Evolution
        ↓
  INSERT mensagens (papel = 'agente') + tokens consumidos
```

O silêncio de 6 horas por `fromMe` é o mecanismo central de convivência entre bot e humano. Ele é renovado a cada mensagem que o balcão envia, então uma conversa assumida por humano permanece assumida enquanto houver atividade humana.

## 7. Prompt e ferramentas

### System prompt (v1, sem preço)

```
# IDENTIDADE
Você é o atendente virtual da MINAS AUTO PEÇAS — peças de moto e oficina, em Altamira/PA.
Sua função é o primeiro atendimento no WhatsApp: descobrir a moto, descobrir a peça,
consultar o sistema e dizer se a loja tem.

# CONTEXTO
Data/hora: {{DATA_HORA}}
Horário de funcionamento: {{HORARIO}}
Endereço: {{ENDERECO}}
Cliente: {{NOME|"não identificado"}}
Moto cadastrada: {{MOTO|"nenhuma"}}

# REGRA NÚMERO 1 — PREÇO
Você NÃO tem acesso a preço. Nunca informe, estime, sugira faixa ou compare valores.
Se o cliente perguntar quanto custa:
"O valor quem te passa é o balcão. Já vou chamar eles aqui — só me confirma se é
essa peça mesmo."
Depois de confirmar a peça, chame `transferir_humano` com motivo "preco".

# REGRA NÚMERO 2 — DISPONIBILIDADE
Só afirme que a loja tem uma peça se `buscar_peca` retornar com estoque maior que zero.
Copie a descrição e o código exatamente como vieram. Nunca invente código.
Se `dias_sem_atualizar` for maior que 7, não afirme quantidade:
"Tenho essa no sistema, mas confirma comigo antes de sair de casa."

# REGRA NÚMERO 3 — COMPATIBILIDADE
Só afirme que a peça serve na moto do cliente se `fitment` vier "humano".
Se vier "auto":
"Tenho um {{peça}} que o sistema marca pra sua {{modelo}}. Confirma comigo antes de vir —
me manda foto da peça velha."
Se vier "nenhum", não fale de compatibilidade; peça foto ou o código da peça velha.
NUNCA deduza compatibilidade por semelhança de nome ou de cilindrada.

# FLUXO
1) Descubra a MOTO antes de qualquer busca: marca, modelo e ano ou cilindrada.
   Se o cliente já tem moto cadastrada, confirme em uma linha: "É pra sua Fan 160, certo?"
2) Descubra a PEÇA. Se vier foto, descreva o que você vê e confirme com o cliente
   antes de buscar. Se não der para identificar, peça foto do outro lado ou do código.
3) Chame `buscar_peca`.
4) Responda em UMA mensagem: peça + se tem.
   Ex: "Tem sim. Retentor dianteiro Fan 160, código 4402. Tenho 3 aqui."
5) Confirme com o cliente que é essa peça mesmo.
6) Chame `transferir_humano` para o balcão fechar valor e separação.

# QUANDO NÃO TIVER A PEÇA
- chame `registrar_demanda` SEMPRE, mesmo que o cliente vá embora;
- ofereça similar apenas se `buscar_peca` retornou alternativa;
- ofereça encomenda: "Consigo pedir. Quer que eu veja com o balcão?"
- não peça desculpa duas vezes.

# COMO FALAR
- Português do Brasil, direto, jeito de balcão. Trate por você.
- Máximo 3 linhas por mensagem. Uma pergunta por vez.
- Sem "prezado cliente", sem texto corporativo, no máximo 1 emoji.
- Não repita o pedido do cliente de volta só para preencher linha.

# PROIBIÇÕES
- Nunca fale preço, desconto, prazo de pagamento, fiado ou promissória.
- Nunca dê diagnóstico mecânico. Você vende peça, não diagnostica.
  Se pedirem diagnóstico, ofereça a oficina.
- Nunca prometa prazo de entrega, de encomenda ou de conserto.
- Nunca peça CPF, foto de documento, dado bancário ou senha.

# OFICINA
Se o cliente quer serviço e não peça: colete moto, problema descrito e preferência de dia,
chame `abrir_servico` e encerre. Não informe valor de mão de obra nem prazo.

# HANDOFF IMEDIATO (`transferir_humano`)
- qualquer pergunta de preço, desconto, fiado ou negociação;
- reclamação, troca, devolução, garantia, defeito em peça vendida;
- cliente pede pessoa, humano ou atendente;
- compra de volume, revenda ou oficina parceira;
- `buscar_peca` voltou ambíguo 2 vezes seguidas;
- qualquer assunto fora de peça de moto e oficina.
Ao transferir: "Vou chamar o pessoal do balcão aqui pra te atender. Um minuto." e pare.

# FORA DO HORÁRIO
Atenda normalmente e diga se tem a peça. Só não prometa separação nem entrega:
"Deixei anotado. Amanhã cedo o balcão te confirma."
```

### Ferramentas

```json
[
  {"name":"identificar_moto",
   "description":"Resolve texto livre do cliente para uma moto do cadastro. Use antes de buscar peça.",
   "input_schema":{"type":"object","properties":{
     "texto":{"type":"string","description":"ex: 'titam 160 2019', 'fan 125'"}},
     "required":["texto"]}},

  {"name":"buscar_peca",
   "description":"Busca no catálogo. Único meio autorizado de afirmar que a loja tem uma peça. Não retorna preço.",
   "input_schema":{"type":"object","properties":{
     "texto":{"type":"string"},
     "moto_id":{"type":"string"}},
     "required":["texto"]}},

  {"name":"registrar_demanda",
   "description":"Obrigatório sempre que a peça não for encontrada ou estiver zerada.",
   "input_schema":{"type":"object","properties":{
     "texto_bruto":{"type":"string"},
     "peca_norm":{"type":"string"},
     "moto_id":{"type":"string"},
     "motivo":{"type":"string","enum":["sem_estoque","nao_cadastrado","nao_trabalhamos"]}},
     "required":["texto_bruto","motivo"]}},

  {"name":"abrir_servico",
   "description":"Registra pedido de serviço na oficina.",
   "input_schema":{"type":"object","properties":{
     "moto_id":{"type":"string"},
     "problema":{"type":"string"},
     "preferencia":{"type":"string"}},
     "required":["problema"]}},

  {"name":"transferir_humano",
   "description":"Encerra o atendimento automático e chama o balcão. Envie resumo pronto para o atendente agir sem reler a conversa.",
   "input_schema":{"type":"object","properties":{
     "motivo":{"type":"string","enum":["preco","desconto","reclamacao","garantia","pedido_humano","revenda","ambiguidade","fora_escopo"]},
     "resumo":{"type":"string","description":"ex: 'Fan 160 2019 — retentor dianteiro — cód. 4402, 3 em estoque — falta passar o valor'"}},
     "required":["motivo","resumo"]}}
]
```

O resumo do handoff é o produto principal do agente. Ele é gravado em `conversas.resumo` e enviado ao número do balcão.

## 8. Falhas, limites e riscos

| Falha | Comportamento definido |
|---|---|
| Anthropic API indisponível ou lenta | 2 tentativas com backoff. Persistindo: envia "Só um minuto, já te respondo", marca `aguardando_humano`, notifica o dono. O agente nunca fica mudo. |
| Evolution indisponível | 3 tentativas. Persistindo: grava em `saidas_pendentes` e notifica. A resposta não se perde. |
| Supabase indisponível | Gateway responde 500 para o Evolution reenviar; grava a mensagem em arquivo local como rede de segurança. |
| Laço de tools não converge em 5 iterações | `transferir_humano` automático, motivo `ambiguidade`. |
| Busca ambígua 2 vezes seguidas | Handoff. |
| Produto com `dias_sem_atualizar` > 7 | O agente para de afirmar quantidade e pede confirmação antes de o cliente se deslocar. |
| Foto ilegível | Resposta padrão pedindo foto do lado com marcação ou código. Duas tentativas, depois handoff. |
| Conversa passa de 30 mensagens | Handoff. Conversa longa indica agente perdido e custo subindo. |

**Kill switch.** `agente.config` guarda `bot_ativo`. Desligar não exige deploy. É a primeira coisa necessária quando o agente erra ao vivo.

**Risco de banimento do número.** Evolution API é conexão não oficial e o número tem histórico de anos. Mitigações no código, não na sorte:

- atraso de 2 a 4 segundos antes da primeira parte da resposta e 1,2 segundo entre partes;
- o agente **nunca** inicia conversa — só responde. O relatório das 07h vai para o número do dono, nunca para clientes;
- teto de contatos novos por hora, configurável em `config`; excedente entra em fila;
- antes de subir em produção, exportar o histórico do número.

**Custo estimado.** Sem preço na resposta, a conversa é curta (6 a 8 mensagens): cerca de US$ 0,02 a 0,03 por conversa com Sonnet 5. Imagem soma aproximadamente 1.500 tokens. Mil conversas por mês ficam em US$ 25 a 40. A extração de fitment com Haiku custa cerca de US$ 2, uma vez.

**LGPD.** `opt_in` registrado no primeiro contato. Cron mensal apaga `mensagens` com mais de 12 meses. Mídia enviada pelo cliente vai para o Storage com expiração.

## 9. Estratégia de testes

**Golden set de busca.** Cinquenta consultas reais de cliente, escritas como cliente escreve, mapeadas ao código esperado. Roda contra o Postgres, sem Claude: segundos, custo zero. Mede recall no topo 3. Toda alteração em normalização, sinônimos ou limiar de similaridade roda este conjunto antes do commit. É o teste mais importante do projeto: busca ruim inutiliza tudo que vem depois.

**Unitários (vitest).** `normalizar`, `expandir`, divisão de mensagem, idempotência, janela de debounce, cálculo de silêncio. Puros, sem rede.

**Aceite (12 casos, com o modelo real).** Executados contra Claude de verdade, porque regressão de prompt só aparece contra o modelo de verdade. Custo aproximado de US$ 0,30 por rodada.

| # | Cliente diz | Comportamento correto |
|---|---|---|
| 1 | "tem retentor pra titam?" | Pergunta cilindrada ou ano antes de buscar |
| 2 | "quanto tá o kit relação da fan 160?" | Não fala preço; confirma peça e estoque; oferece o balcão |
| 3 | Pede peça que não existe no catálogo | Registra demanda e oferece encomenda |
| 4 | Manda foto de peça quebrada | Descreve, confirma com o cliente, só então busca |
| 5 | "faz por 20?" | Handoff, sem contraproposta |
| 6 | "comprei ontem e já queimou" | Handoff imediato, sem defender a loja |
| 7 | Peça que serve em outra cilindrada | Não afirma compatibilidade; pede confirmação |
| 8 | "minha moto tá falhando, o que é?" | Não diagnostica; oferece a oficina |
| 9 | Manda 4 mensagens picadas | Uma resposta só |
| 10 | Pergunta às 22h | Responde se tem; não promete separação |
| 11 | Balcão responde no meio da conversa | Bot cala por 6 horas naquela conversa |
| 12 | Insiste no preço duas vezes | Handoff, sem repetir desculpa |

Nenhum caso pode falhar para o piloto começar. O caso 7 é o mais caro de errar: compatibilidade afirmada errado gera devolução, frete e cliente perdido.

## 10. Fases de entrega

```
F1  VPS + Docker Compose (Evolution, postgres, redis)
    Projeto Supabase novo, schema, RLS restrita a service_role
F2  Importador xlsx → normalização → seed de sinônimos → seed de motos
    → extração de fitment com Haiku → golden set de busca passando
F3  Gateway: webhook, idempotência, debounce, silêncio por fromMe, histórico
    Conversa com Claude, ainda sem ferramentas
F4  Ferramentas, uma por vez, na ordem:
    identificar_moto → buscar_peca → registrar_demanda → abrir_servico → transferir_humano
F5  Resiliência: retries, saidas_pendentes, kill switch, tetos, notificação ao dono
F6  12 testes de aceite + piloto de uma semana com humano lendo 100% das conversas
F7  Cron 07h da lista de compra por demanda real
```

F2 é o portão do projeto. Se a busca não encontrar a peça do jeito que o cliente escreve, nada depois disso importa. Não se avança para F3 sem o golden set aprovado.

## 11. Métricas

```sql
-- Funil semanal
select
  count(*)                                                as conversas,
  count(*) filter (where intencao = 'peca')               as buscaram_peca,
  count(*) filter (where desfecho = 'qualificou')         as qualificadas,
  count(*) filter (where desfecho = 'sem_estoque')        as sem_estoque,
  round(100.0 * count(*) filter (where desfecho = 'qualificou')
        / nullif(count(*), 0), 1)                         as taxa_qualificacao
from agente.conversas
where iniciada_em > now() - interval '7 days';

-- Lista de compra por demanda real
select d.peca_norm, m.marca, m.modelo, m.cilindrada, count(*) as pedidos
from agente.demanda_nao_atendida d
left join agente.motos m on m.id = d.moto_id
where d.criado_em > now() - interval '30 days'
group by 1, 2, 3, 4
having count(*) >= 3
order by pedidos desc;
```

A segunda consulta é o retorno comercial do projeto: uma lista de compra baseada no que o cliente pediu e a loja não tinha, em vez de intuição do dono.

## 12. Definição de pronto (v1)

- Golden set de busca com recall aprovado no topo 3.
- Os 12 testes de aceite passando.
- Kill switch testado em produção.
- Uma semana de piloto com leitura humana de 100% das conversas, sem caso de compatibilidade afirmada errado.
- Relatório das 07h chegando no WhatsApp do dono.
