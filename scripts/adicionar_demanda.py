"""Registra uma sugestao como demanda rastreavel em demandas/demandas.json.

Tipos de criterio de verificacao (avaliados por verificar_demandas.py, sem IA):
  entrada_estoque  saldo do SKU aumentou depois da data da sugestao
  saldo_minimo     saldo atual do SKU >= --valor
  preco_alterado   preco do SKU mudou depois da data da sugestao
  manual           nao mensuravel pelos dados; fica pendente ate expirar ou ser descartada

Exemplo:
  python scripts/adicionar_demanda.py --agente estoque --sku CAD-200-AZ \
      --sugestao "Comprar 300 un de caderno 200 folhas azul" \
      --justificativa "Cobertura 4 dias, giro 12 un/dia" \
      --tipo entrada_estoque --prazo-dias 14
"""
import argparse
import sys
from datetime import date, timedelta

from common import DEMANDAS, gravar_json, hoje, ler_json

TIPOS = ("entrada_estoque", "saldo_minimo", "preco_alterado", "manual")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agente", required=True, choices=["estoque", "vendas", "marketing"])
    ap.add_argument("--sku", default="")
    ap.add_argument("--sugestao", required=True)
    ap.add_argument("--justificativa", default="")
    ap.add_argument("--tipo", required=True, choices=TIPOS)
    ap.add_argument("--valor", type=float, default=None, help="usado em saldo_minimo")
    ap.add_argument("--prazo-dias", type=int, default=14)
    a = ap.parse_args()

    if a.tipo != "manual" and not a.sku:
        sys.exit("--sku e obrigatorio para criterios automaticos.")
    if a.tipo == "saldo_minimo" and a.valor is None:
        sys.exit("--valor e obrigatorio para saldo_minimo.")

    doc = ler_json(DEMANDAS, {"demandas": []})
    demandas = doc["demandas"]

    # Evita duplicata: mesma sugestao/SKU/tipo ainda pendente.
    for d in demandas:
        if (d["status"] == "pendente" and d["agente"] == a.agente
                and d["criterio_verificacao"]["sku"] == a.sku
                and d["criterio_verificacao"]["tipo"] == a.tipo):
            print(f"Ja existe demanda pendente equivalente: {d['id']} (nada criado).")
            return

    numero = 1 + max((int(d["id"].split("-")[1]) for d in demandas), default=0)
    criada = hoje()
    expira = (date.fromisoformat(criada) + timedelta(days=a.prazo_dias)).isoformat()
    nova = {
        "id": f"D-{numero:04d}",
        "agente": a.agente,
        "criada_em": criada,
        "sugestao": a.sugestao,
        "justificativa": a.justificativa,
        "criterio_verificacao": {
            "tipo": a.tipo,
            "sku": a.sku,
            "valor": a.valor,
            "apos": criada,
        },
        "status": "pendente",
        "expira_em": expira,
        "verificada_em": None,
    }
    demandas.append(nova)
    gravar_json(DEMANDAS, doc)
    print(f"Demanda criada: {nova['id']} (expira em {expira})")


if __name__ == "__main__":
    main()
