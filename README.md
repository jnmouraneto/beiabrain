# beiabrain: BeIa, a orquestradora da Be Papel

Orquestrador de agentes de IA (Claude Code) para uma papelaria, alimentado pelo Bling.

```
Vercel Cron -> coletor/ (Bling API) -> dados/entrada/*.json.gz no GitHub
                                              |  (push dispara o Actions)
              scripts Python (sem IA) -> SQLite + resumo diario (poucos KB)
                                              |
                       Orquestrador (CLAUDE.md) + subagentes (.claude/agents)
                                              |
                  relatorio do dia + demandas rastreaveis + memoria do CEO
```

## Principio de economia de tokens
O Claude nunca le os ~2 mil produtos. Python compara hoje x ontem, calcula giro, cobertura e
alertas, e gera `dados/diario/AAAA-MM-DD-resumo.json` (~4 KB). Detalhes pontuais vem de
`scripts/consulta.py` (SQL somente leitura, saida truncada).

## Scripts
| Script | O que faz |
|---|---|
| `puxar_bling.py` | Coleta manual/local da API v3 (alternativa ao coletor da Vercel; nao use os dois com o mesmo token) |
| `importar_vendas.py` | Importa o historico de vendas de `dados/historico/` para o SQLite |
| `gerar_diff.py` | Le `dados/entrada/` (ou `--data ultima`), atualiza o SQLite e gera o resumo do dia (idempotente) |
| `adicionar_demanda.py` | Registra uma sugestao com criterio de verificacao |
| `verificar_demandas.py` | Marca demandas como atendida/pendente/expirada e gera `demandas/placar.json` |
| `consulta.py` | SQL somente leitura para os agentes |
| `mock_bling.py` | Dados simulados para testar sem o Bling |

## Testar sem o Bling
```bash
pip install requests
python scripts/mock_bling.py --data 2026-10-28 --cenario 1
python scripts/gerar_diff.py --data 2026-10-28
python scripts/mock_bling.py --data 2026-10-29 --cenario 2
python scripts/gerar_diff.py --data 2026-10-29
python scripts/verificar_demandas.py --data 2026-10-29
```
Use `BEIA_ROOT=/pasta/qualquer` para nao misturar o teste com os dados reais.

## Coleta do Bling e rotina diaria
A coleta roda na Vercel (pasta `coletor/`, passo a passo em `coletor/README.md`) e publica
`dados/entrada/AAAA-MM-DD.json.gz`. O push dispara o workflow *Rotina diaria*, que gera o diff,
verifica as demandas e aciona a BeIa. Secrets do GitHub necessarios: apenas `ANTHROPIC_API_KEY`.
Atencao: o plano Hobby da Vercel e so para uso nao comercial; em producao use o Pro.

## Usar no dia a dia
`git pull`, abrir o Claude Code nesta pasta e conversar com o orquestrador.
O que o CEO decidir vai para `memoria/`, e as sugestoes aparecem em `demandas/`.

## Seguranca
- Repositorio privado. `dados/bruto/` e tokens estao no `.gitignore`.
- Os agentes so sugerem; nenhuma escrita no Bling.
