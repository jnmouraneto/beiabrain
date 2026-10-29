"""Consulta SOMENTE LEITURA no SQLite, com saida compacta para economizar tokens.

Uso: python scripts/consulta.py "SELECT codigo, nome FROM produtos LIMIT 5"
Tabelas: produtos, saldos, movimentos, precos_hist, vendas_itens, clientes.
Saida limitada a 50 linhas por padrao (--max para mudar).
"""
import argparse
import sqlite3
import sys

from common import DB_PATH


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sql")
    ap.add_argument("--max", type=int, default=50)
    a = ap.parse_args()

    if not DB_PATH.exists():
        sys.exit("Banco ainda nao existe. Rode gerar_diff.py primeiro.")
    # Abre em modo somente leitura: qualquer escrita falha no nivel do SQLite.
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        cur = con.execute(a.sql)
        cols = [c[0] for c in cur.description or []]
        linhas = cur.fetchmany(a.max + 1)
    except sqlite3.Error as e:
        sys.exit(f"Erro SQL: {e}")
    print(" | ".join(cols))
    for l in linhas[: a.max]:
        print(" | ".join("" if v is None else str(v) for v in l))
    if len(linhas) > a.max:
        print(f"... (truncado em {a.max} linhas; use LIMIT/filtros)")


if __name__ == "__main__":
    main()
