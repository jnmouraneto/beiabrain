"""Verifica as demandas pendentes contra os dados do SQLite e atualiza o status.

Sem IA. Roda depois de gerar_diff.py. Atualiza demandas/demandas.json e
demandas/placar.json (contagem para o relatorio e para o portal).

Uso: python scripts/verificar_demandas.py [--data AAAA-MM-DD]
"""
import argparse
from collections import Counter

from common import DEMANDAS, PLACAR, conectar, gravar_json, hoje, ler_json


def produto_id(cur, sku):
    r = cur.execute("SELECT id FROM produtos WHERE codigo = ?", (sku,)).fetchone()
    return r["id"] if r else None


def atendida(cur, crit, data):
    tipo, sku, apos = crit["tipo"], crit["sku"], crit["apos"]
    if tipo == "manual":
        return False
    pid = produto_id(cur, sku)
    if pid is None:
        return False
    if tipo == "entrada_estoque":
        return cur.execute(
            "SELECT 1 FROM movimentos WHERE produto_id=? AND delta>0 AND data>? AND data<=?",
            (pid, apos, data)).fetchone() is not None
    if tipo == "saldo_minimo":
        r = cur.execute(
            "SELECT saldo FROM saldos WHERE produto_id=? AND data=?", (pid, data)).fetchone()
        return r is not None and r["saldo"] >= (crit.get("valor") or 0)
    if tipo == "preco_alterado":
        return cur.execute(
            "SELECT 1 FROM precos_hist WHERE produto_id=? AND data>? AND data<=?",
            (pid, apos, data)).fetchone() is not None
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=hoje())
    data = ap.parse_args().data

    doc = ler_json(DEMANDAS, {"demandas": []})
    cur = conectar().cursor()
    mudou = []
    for d in doc["demandas"]:
        if d["status"] != "pendente":
            continue
        if atendida(cur, d["criterio_verificacao"], data):
            d["status"], d["verificada_em"] = "atendida", data
            mudou.append((d["id"], "atendida"))
        elif data > d["expira_em"]:
            d["status"], d["verificada_em"] = "expirada", data
            mudou.append((d["id"], "expirada"))
    gravar_json(DEMANDAS, doc)

    contagem = Counter(d["status"] for d in doc["demandas"])
    por_agente = {}
    for d in doc["demandas"]:
        por_agente.setdefault(d["agente"], Counter())[d["status"]] += 1
    total = len(doc["demandas"])
    fechadas = contagem["atendida"] + contagem["expirada"]
    placar = {
        "data": data,
        "total": total,
        "pendente": contagem["pendente"],
        "atendida": contagem["atendida"],
        "expirada": contagem["expirada"],
        "descartada": contagem["descartada"],
        "taxa_atendimento": round(contagem["atendida"] / fechadas, 2) if fechadas else None,
        "por_agente": {k: dict(v) for k, v in por_agente.items()},
        "mudancas_hoje": [{"id": i, "status": s} for i, s in mudou],
        "pendentes": [
            {"id": d["id"], "agente": d["agente"], "sugestao": d["sugestao"],
             "criada_em": d["criada_em"], "expira_em": d["expira_em"]}
            for d in doc["demandas"] if d["status"] == "pendente"
        ],
    }
    gravar_json(PLACAR, placar)
    print(f"Placar: {placar['atendida']} atendidas, {placar['pendente']} pendentes, "
          f"{placar['expirada']} expiradas. Mudancas hoje: {mudou or 'nenhuma'}")


if __name__ == "__main__":
    main()
