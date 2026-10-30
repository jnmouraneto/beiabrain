"""Importa o historico de vendas publicado pelo coletor em dados/historico/vendas-*.json.gz.

Idempotente (INSERT OR IGNORE): pode rodar varias vezes e com janelas que se sobrepoem.
Tambem importa os clientes que aparecem nos pedidos. Nao altera produtos, saldos nem movimentos. Depois de importar, rode gerar_diff.py para
recalcular giro e cobertura com o historico.

Uso: python scripts/importar_vendas.py
"""
import gzip
import json

from common import DADOS, conectar


def main():
    arquivos = sorted((DADOS / "historico").glob("vendas-*.json.gz"))
    if not arquivos:
        print("Nenhum arquivo em dados/historico/.")
        return
    con = conectar()
    cur = con.cursor()
    total_antes = cur.execute("SELECT COUNT(*) FROM vendas_itens").fetchone()[0]
    for arq in arquivos:
        with gzip.open(arq, "rt", encoding="utf-8") as f:
            d = json.load(f)
        for v in d["vendas"]:
            for it in v["itens"]:
                cur.execute(
                    "INSERT OR IGNORE INTO vendas_itens VALUES (?,?,?,?,?,?)",
                    (v["id"], v["data"], v["cliente_id"], it["produto_id"],
                     it["quantidade"], it["valor"]),
                )
        # Clientes vem dos pedidos (nome, tipo, hash do documento). "primeira_vez" = fim da janela.
        for c in d.get("clientes", []):
            cur.execute(
                "INSERT OR IGNORE INTO clientes VALUES (?,?,?,?,?)",
                (c["id"], c["nome"], c["tipo"], c["doc_hash"], d["ate"]),
            )
        print(f"{arq.name}: {len(d['vendas'])} pedidos, {len(d.get('clientes', []))} clientes")
    con.commit()
    total_depois = cur.execute("SELECT COUNT(*) FROM vendas_itens").fetchone()[0]
    faixa = cur.execute("SELECT MIN(data), MAX(data) FROM vendas_itens").fetchone()
    print(f"Itens de venda: {total_antes} -> {total_depois} (periodo {faixa[0]} a {faixa[1]})")


if __name__ == "__main__":
    main()
