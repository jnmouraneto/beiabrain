# Coletor do Bling (Vercel)

Função agendada na Vercel que puxa os dados do Bling todo dia e os publica no GitHub:

```
Vercel Cron (06:00 BRT, ±59 min) -> /api/coletar
   |  token do Bling no Redis (Upstash)  -> API v3 do Bling
   v
GitHub: dados/entrada/AAAA-MM-DD.json.gz  --(push)-->  Actions: diff + demandas + BeIa
```

Nao ha disco na Vercel, entao tudo que precisa sobreviver (refresh token, cache de detalhes,
cursor, lock) fica no Redis. Os dados vao para o repositorio como um unico `.json.gz` por dia.

## Limites que moldam o desenho (conferidos na documentacao da Vercel em 29/10/2026)
- **Hobby:** cron 1x por dia, horario com ate 59 min de imprecisao; funcao de ate 300 s.
- **Hobby e so para uso pessoal e nao comercial.** A Be Papel e um negocio: para producao use o
  plano **Pro** (US$ 20 por usuario/mes) numa conta da Vercel sua ou do cliente. Em Hobby, so
  para testar e validar.
- Por isso a funcao termina em ~1-2 min na coleta diaria, e o que e lento (estoque minimo/custo
  por produto, ~2 mil chamadas) e feito aos poucos, nos minutos que sobram de cada execucao.
  O estoque minimo e o custo aparecem no arquivo **do dia seguinte** em diante (cache no Redis).

## Passo a passo

### 1. App no Bling (uma vez)
1. Crie o app da API v3 na area do desenvolvedor do Bling e anote **client id** e **client secret**.
2. Autorize o app (link de convite do app). O Bling redireciona com um `code`; troque-o por tokens
   (`POST /oauth/token`, `grant_type=authorization_code`, mesma autenticacao Basic). Guarde o
   **refresh token** que vier. Confira os detalhes na documentacao do Bling.

### 2. Token do GitHub (uma vez)
Crie um token **fine-grained** so para o repositorio `beiabrain`, com **Contents: Read and write**.
Ele permite que a funcao publique os arquivos e, por ser token de usuario, o push dispara o Actions.

### 3. Projeto na Vercel
1. *Add New > Project*, importe `jnmouraneto/beiabrain`.
2. **Root Directory: `coletor`**. Framework: *Other*.
3. Aba *Storage* (ou Marketplace) > adicione **Upstash for Redis** (plano gratuito) e conecte
   ao projeto. As variaveis do Redis sao injetadas sozinhas.
4. *Settings > Environment Variables*:

| Variavel | Valor |
|---|---|
| `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET` | do app do Bling |
| `GITHUB_TOKEN` | token fine-grained do passo 2 |
| `GITHUB_REPO` | `jnmouraneto/beiabrain` |
| `CRON_SECRET` | texto aleatorio longo (a Vercel o envia no cabecalho do cron) |
| `VENDAS_DIAS` | opcional, janela diaria de vendas (padrao 2) |

5. Deploy. O `ignoreCommand` do `vercel.json` evita redeploy a cada commit de dados.

### 4. Semear o refresh token (uma vez)
```bash
cd coletor && npm install
npx vercel link && npx vercel env pull .env.local
# carregue as variaveis do .env.local e rode:
BLING_REFRESH_TOKEN="<token do passo 1>" npm run semear-token
```
Depois disso **nao use mais esse token em outro lugar** (nem no `puxar_bling.py`): o Bling invalida
o anterior a cada renovacao, e quem renova e a funcao.

### 5. Carga do historico de vendas (uma vez, antes de depender do giro)
Sem historico, giro, cobertura e parados ficam vazios por ~1 mes. Janelas de 7 dias, da mais antiga
para a mais recente (ex.: 90 dias = 13 chamadas):
```bash
URL=https://SEU-PROJETO.vercel.app/api/coletar
for ate in 2026-08-06 2026-08-13 2026-08-20 2026-08-27 2026-09-03 2026-09-10 2026-09-17 \
           2026-09-24 2026-10-01 2026-10-08 2026-10-15 2026-10-22 2026-10-29; do
  curl -sS -H "Authorization: Bearer $CRON_SECRET" "$URL?ate=$ate&dias=7"; echo
done
```
Cada chamada publica `dados/historico/vendas-<data>.json.gz`; o workflow *Importar historico de
vendas* grava tudo no banco. Se uma chamada responder erro de tempo, use `dias=3`.
Janelas que se sobrepoem sao seguras (importacao idempotente).

### 6. Testar a coleta diaria
```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" "$URL"
```
Resposta com `arquivo`, `produtos`, `pedidos` etc. Em seguida o GitHub Actions deve disparar
(*Rotina diaria*). Para acompanhar: aba *Logs* na Vercel e aba *Actions* no GitHub.

## Operacao
- **Conflito de execucoes:** um lock no Redis impede duas execucoes ao mesmo tempo (resposta 409).
  Ele expira sozinho em ~5 min caso uma execucao morra.
- **Se o refresh token se perder** (Redis apagado, ou 30+ dias sem rodar): autorize o app de novo
  no Bling e rode `npm run semear-token -- --forcar`.
- **Falhas:** a funcao responde 500 com o motivo; configure alerta de falha de cron na Vercel.
  Se a coleta falhar antes de publicar, nada e publicado e a rotina diaria nao roda naquele dia.
- **Privacidade:** CPF/CNPJ viram hash na coleta; telefone e e-mail nunca sao lidos.
- **Testes:** `npm test` (Bling, Redis e GitHub simulados; nenhuma rede).
