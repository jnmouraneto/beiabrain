"""Gera dados SIMULADOS no mesmo formato de puxar_bling.py, para testar o pipeline sem o Bling.

Uso: python scripts/mock_bling.py --data 2026-10-28 --cenario 1
     python scripts/mock_bling.py --data 2026-10-29 --cenario 2
Cenario 1: dia base. Cenario 2: entradas de estoque, vendas, preco alterado, produto novo.
"""
import argparse
import random

from common import BRUTO, gravar_json

N = 60


def base():
    produtos = []
    for i in range(1, N + 1):
        produtos.append(
            {"id": i, "codigo": f"SKU-{i:03d}", "nome": f"Produto de papelaria {i}",
             "preco": round(5 + i * 0.7, 2), "custo": round(3 + i * 0.4, 2),
             "estoque_min": 10.0 if i % 5 == 0 else 0.0, "situacao": "A"}
        )
    return produtos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--cenario", type=int, default=1)
    a = ap.parse_args()
    random.seed(a.cenario)

    produtos = base()
    saldos = {p["id"]: float(random.randint(0, 80)) for p in produtos}
    vendas = []
    if a.cenario == 1:
        # historico de vendas dos ultimos dias para dar giro
        pedido = 1000
        for dia in ("2026-10-20", "2026-10-22", "2026-10-24", "2026-10-26", "2026-10-28"):
            for _ in range(8):
                pedido += 1
                itens = [{"produto_id": random.randint(1, 20), "quantidade": float(random.randint(1, 5)),
                          "valor": 10.0} for _ in range(2)]
                vendas.append({"id": pedido, "data": dia, "cliente_id": random.randint(1, 5),
                               "total": 0, "itens": itens})
    else:
        # estado do dia 2: partir do mesmo seed do cenario 1 e aplicar mudancas
        random.seed(1)
        saldos = {p["id"]: float(random.randint(0, 80)) for p in produtos}
        saldos[3] += 200   # entrada de estoque no SKU-003
        saldos[7] -= min(saldos[7], 5)  # saida
        saldos[12] = 0.0   # ruptura em item que gira
        produtos[9]["preco"] = round(produtos[9]["preco"] * 0.8, 2)  # SKU-010 em promocao
        produtos.append({"id": N + 1, "codigo": f"SKU-{N+1:03d}", "nome": "Produto novo",
                         "preco": 19.9, "custo": 9.0, "estoque_min": 0.0, "situacao": "A"})
        saldos[N + 1] = 30.0
        vendas = [{"id": 2001, "data": a.data, "cliente_id": 6, "total": 0,
                   "itens": [{"produto_id": 12, "quantidade": 4.0, "valor": 10.0},
                             {"produto_id": 5, "quantidade": 2.0, "valor": 10.0}]}]

    clientes = [{"id": i, "nome": f"Cliente {i}", "tipo": "J", "doc_hash": f"hash{i}"}
                for i in range(1, 6 + (1 if a.cenario == 2 else 0))]
    pasta = BRUTO / a.data
    gravar_json(pasta / "produtos.json", produtos)
    gravar_json(pasta / "saldos.json", [{"produto_id": k, "saldo": v} for k, v in saldos.items()])
    gravar_json(pasta / "clientes.json", clientes)
    gravar_json(pasta / "vendas.json", vendas)
    print(f"Mock cenario {a.cenario} gerado em {pasta}")


if __name__ == "__main__":
    main()
