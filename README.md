# beiabrain

Orquestrador de agentes de IA (Claude Code) para uma papelaria, alimentado pelo Bling.

```
Bling API -> scripts Python (sem IA) -> SQLite + resumo diario (poucos KB)
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
| `puxar_bling.py` | Coleta produtos, saldos, clientes e vendas da API v3 (CPF/CNPJ vira hash; sem telefone/e-mail) |
| `gerar_diff.py` | Atualiza o SQLite, detecta variacoes e gera o resumo do dia (idempotente) |
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

## Configurar o Bling
1. No Bling: Preferencias > Sistema > Integracoes (Area do Desenvolvedor) > criar app da API v3.
2. Autorizar o app uma vez (fluxo OAuth) para obter o primeiro `refresh_token`.
3. Variaveis: `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`, `BLING_REFRESH_TOKEN`.
4. Carga inicial: `python scripts/puxar_bling.py --dias 90 --detalhes` (o `--detalhes` busca estoque
   minimo e custo por produto, ~3 req/s: cerca de 12 min para 2 mil produtos; rode so de vez em quando).

## Secrets do GitHub (rotina diaria)
`BLING_CLIENT_ID`, `BLING_CLIENT_SECRET`, `BLING_REFRESH_TOKEN`, `ANTHROPIC_API_KEY` e
`GH_PAT_SECRETS` (token fine-grained com "Secrets: read and write" so neste repo, usado para
guardar o refresh token novo que o Bling gera a cada execucao).

## Usar no dia a dia
`git pull`, abrir o Claude Code nesta pasta e conversar com o orquestrador.
O que o CEO decidir vai para `memoria/`, e as sugestoes aparecem em `demandas/`.

## Seguranca
- Repositorio privado. `dados/bruto/` e tokens estao no `.gitignore`.
- Os agentes so sugerem; nenhuma escrita no Bling.
