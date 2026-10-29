"""Le dados/bruto/<data>/, atualiza o SQLite e gera o resumo incremental do dia.

Nenhuma IA aqui: so Python/SQL. O Claude le apenas o JSON de saida
(dados/diario/<data>-resumo.json), nunca os arquivos brutos.

Uso: python scripts/gerar_diff.py [--data AAAA-MM-DD]
"""
import argparse
import gzip
import json
import sys

from common import BRUTO, DIARIO, ENTRADA, conectar, gravar_json, hoje, ler_json

TOP = 15  # limite de itens por lista no resumo (economia de tokens)


def carregar(data):
    # 1) Caminho normal: arquivo unico publicado pelo coletor da Vercel.
    gz = ENTRADA / f"{data}.json.gz"
    if gz.exists():
        with gzip.open(gz, "rt", encoding="utf-8") as f:
            d = json.load(f)
        return d["produtos"], d["saldos"], d["clientes"], d["vendas"]
    # 2) Alternativa manual: pasta dados/bruto/<data>/ gerada por puxar_bling.py ou mock_bling.py.
    pasta = BRUTO / data
    if not pasta.exists():
        sys.exit(f"Sem dados para {data}: nem {gz} nem {pasta}")
    return (
        ler_json(pasta / "produtos.json", []),
        ler_json(pasta / "saldos.json", []),
        ler_json(pasta / "clientes.json", []),
        ler_json(pasta / "vendas.json", []),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=hoje(),
                    help="AAAA-MM-DD ou 'ultima' (arquivo mais recente em dados/entrada)")
    data = ap.parse_args().data
    if data == "ultima":
        arquivos = sorted(ENTRADA.glob("*.json.gz"))
        if not arquivos:
            sys.exit(f"Nenhum arquivo em {ENTRADA}")
        data = arquivos[-1].name.removesuffix(".json.gz")
        print(f"Usando o arquivo mais recente: {data}")

    produtos, saldos, clientes, vendas = carregar(data)
    con = conectar()
    cur = con.cursor()

    anterior = cur.execute("SELECT MAX(data) FROM saldos WHERE data < ?", (data,)).fetchone()[0]
    primeira_carga = anterior is None

    # Re-executar o mesmo dia deve ser idempotente.
    # (precos_hist, produtos.primeira_vez e clientes.primeira_vez nao sao apagados: a mudanca
    # so e detectavel na primeira execucao do dia, entao o resumo le esses dados do banco.)
    cur.execute("DELETE FROM movimentos WHERE data = ?", (data,))
    cur.execute("DELETE FROM saldos WHERE data = ?", (data,))

    # --- produtos: novos e mudancas de preco ---
    existentes = {r["id"]: r for r in cur.execute("SELECT * FROM produtos")}
    for p in produtos:
        antigo = existentes.get(p["id"])
        if antigo is None:
            cur.execute(
                "INSERT INTO produtos VALUES (?,?,?,?,?,?,?,?)",
                (p["id"], p["codigo"], p["nome"], p["preco"], p["custo"],
                 p["estoque_min"], p["situacao"], data),
            )
        else:
            if abs((antigo["preco"] or 0) - p["preco"]) > 0.001:
                cur.execute(
                    "INSERT OR REPLACE INTO precos_hist VALUES (?,?,?,?)",
                    (data, p["id"], antigo["preco"], p["preco"]),
                )
            # estoque_min/custo so sobrescrevem se vieram preenchidos (modo --detalhes)
            estoque_min = p["estoque_min"] or antigo["estoque_min"]
            custo = p["custo"] or antigo["custo"]
            cur.execute(
                "UPDATE produtos SET codigo=?, nome=?, preco=?, custo=?, estoque_min=?, situacao=? WHERE id=?",
                (p["codigo"], p["nome"], p["preco"], custo, estoque_min, p["situacao"], p["id"]),
            )

    # --- saldos e movimentos (variacao contra o ultimo snapshot) ---
    saldo_ant = {}
    if anterior:
        saldo_ant = {
            r["produto_id"]: r["saldo"]
            for r in cur.execute("SELECT produto_id, saldo FROM saldos WHERE data = ?", (anterior,))
        }
    for s in saldos:
        cur.execute("INSERT INTO saldos VALUES (?,?,?)", (data, s["produto_id"], s["saldo"]))
        if anterior and s["produto_id"] in saldo_ant:
            delta = s["saldo"] - saldo_ant[s["produto_id"]]
            if abs(delta) > 1e-9:
                cur.execute(
                    "INSERT INTO movimentos VALUES (?,?,?,?,?)",
                    (data, s["produto_id"], saldo_ant[s["produto_id"]], s["saldo"], delta),
                )

    # --- clientes ---
    clientes_antes = {r["id"] for r in cur.execute("SELECT id FROM clientes")}
    for c in clientes:
        if c["id"] not in clientes_antes:
            cur.execute(
                "INSERT INTO clientes VALUES (?,?,?,?,?)",
                (c["id"], c["nome"], c["tipo"], c["doc_hash"], data),
            )
        else:
            cur.execute("UPDATE clientes SET nome=? WHERE id=?", (c["nome"], c["id"]))

    # --- vendas (INSERT OR IGNORE: janelas de dias se sobrepoem) ---
    for v in vendas:
        for it in v["itens"]:
            cur.execute(
                "INSERT OR IGNORE INTO vendas_itens VALUES (?,?,?,?,?,?)",
                (v["id"], v["data"], v["cliente_id"], it["produto_id"], it["quantidade"], it["valor"]),
            )
    con.commit()

    # ================= RESUMO =================
    nome_de = {r["id"]: (r["codigo"], r["nome"]) for r in cur.execute("SELECT id,codigo,nome FROM produtos")}

    def ref(pid):
        cod, nome = nome_de.get(pid, ("?", "?"))
        return {"codigo": cod, "nome": nome}

    novos, preco_alterado, clientes_novos = [], [], 0
    if not primeira_carga:
        novos = [
            {"codigo": r["codigo"], "nome": r["nome"], "preco": r["preco"]}
            for r in cur.execute("SELECT * FROM produtos WHERE primeira_vez = ?", (data,))
        ]
        clientes_novos = cur.execute(
            "SELECT COUNT(*) FROM clientes WHERE primeira_vez = ?", (data,)).fetchone()[0]
    preco_alterado = [
        {"codigo": nome_de[r["produto_id"]][0], "nome": nome_de[r["produto_id"]][1],
         "de": r["preco_anterior"], "para": r["preco_novo"]}
        for r in cur.execute("SELECT * FROM precos_hist WHERE data = ?", (data,))
    ]

    venda_dia = cur.execute(
        """SELECT COUNT(DISTINCT pedido_id) pedidos, COALESCE(SUM(quantidade),0) itens,
                  COALESCE(SUM(quantidade*valor_unit),0) faturamento
           FROM vendas_itens WHERE data = ?""", (data,)).fetchone()
    media7 = cur.execute(
        """SELECT COALESCE(SUM(quantidade*valor_unit),0)/7.0 FROM vendas_itens
           WHERE data >= date(?, '-7 day') AND data < ?""", (data, data)).fetchone()[0]
    top_vendidos = [
        {**ref(r["produto_id"]), "qtd": r["q"]}
        for r in cur.execute(
            """SELECT produto_id, SUM(quantidade) q FROM vendas_itens WHERE data = ?
               GROUP BY produto_id ORDER BY q DESC LIMIT ?""", (data, 10))
    ]

    # giro dos ultimos 30 dias
    giro = {
        r["produto_id"]: r["q"] / 30.0
        for r in cur.execute(
            """SELECT produto_id, SUM(quantidade) q FROM vendas_itens
               WHERE data > date(?, '-30 day') AND data <= ? GROUP BY produto_id""", (data, data))
    }
    vendeu_90d = {
        r["produto_id"]
        for r in cur.execute(
            "SELECT DISTINCT produto_id FROM vendas_itens WHERE data > date(?, '-90 day')", (data,))
    }
    tem_historico_vendas = cur.execute(
        "SELECT MIN(data) FROM vendas_itens").fetchone()[0]

    ruptura, abaixo_min, cobertura_critica, parados = [], [], [], []
    for r in cur.execute(
        """SELECT p.id, p.codigo, p.nome, p.preco, p.custo, p.estoque_min, s.saldo
           FROM produtos p JOIN saldos s ON s.produto_id = p.id AND s.data = ?
           WHERE p.situacao = 'A'""", (data,)):
        g = giro.get(r["id"], 0.0)
        saldo = r["saldo"]
        base = {"codigo": r["codigo"], "nome": r["nome"], "saldo": saldo, "giro_dia": round(g, 2)}
        if saldo <= 0 and g > 0:
            ruptura.append(base)
        elif r["estoque_min"] and saldo < r["estoque_min"]:
            abaixo_min.append({**base, "minimo": r["estoque_min"]})
        elif g > 0 and saldo / g < 7:
            cobertura_critica.append({**base, "cobertura_dias": round(saldo / g, 1)})
        if saldo > 0 and r["id"] not in vendeu_90d and tem_historico_vendas:
            valor = saldo * (r["custo"] or r["preco"] or 0)
            parados.append({**base, "valor_parado": round(valor, 2)})

    ruptura.sort(key=lambda x: -x["giro_dia"])
    abaixo_min.sort(key=lambda x: x["saldo"] - x["minimo"])
    cobertura_critica.sort(key=lambda x: x["cobertura_dias"])
    parados.sort(key=lambda x: -x["valor_parado"])

    mov = [
        {**ref(r["produto_id"]), "de": r["saldo_anterior"], "para": r["saldo_novo"], "delta": r["delta"]}
        for r in cur.execute(
            "SELECT * FROM movimentos WHERE data = ? ORDER BY ABS(delta) DESC", (data,))
    ]
    entradas = [m for m in mov if m["delta"] > 0]

    resumo = {
        "data": data,
        "comparado_com": anterior,
        "primeira_carga": primeira_carga,
        "totais": {
            "produtos_ativos": len(produtos),
            "clientes_novos": clientes_novos,
            "produtos_novos": len(novos),
        },
        "vendas": {
            "pedidos": venda_dia["pedidos"],
            "itens": venda_dia["itens"],
            "faturamento": round(venda_dia["faturamento"], 2),
            "media_faturamento_7d": round(media7, 2),
            "top_vendidos": top_vendidos,
        },
        "estoque": {
            "produtos_com_variacao": len(mov),
            "entradas": entradas[:TOP],
            "maiores_saidas": [m for m in mov if m["delta"] < 0][:TOP],
        },
        "alertas": {
            "ruptura": {"total": len(ruptura), "itens": ruptura[:TOP]},
            "abaixo_minimo": {"total": len(abaixo_min), "itens": abaixo_min[:TOP]},
            "cobertura_menor_7d": {"total": len(cobertura_critica), "itens": cobertura_critica[:TOP]},
            "parados_90d": {
                "total": len(parados),
                "valor_total": round(sum(x["valor_parado"] for x in parados), 2),
                "itens": parados[:10],
            },
        },
        "mudancas": {
            "produtos_novos": novos[:TOP],
            "preco_alterado": preco_alterado[:TOP],
        },
    }
    if primeira_carga:
        resumo["aviso"] = "Primeira carga: ainda nao ha comparacao com dia anterior."
    if not tem_historico_vendas:
        resumo["aviso_vendas"] = "Sem historico de vendas; giro, cobertura e parados indisponiveis."

    gravar_json(DIARIO / f"{data}-resumo.json", resumo)
    print(f"Resumo gerado: {DIARIO / (data + '-resumo.json')}")
    print(
        f"  variacoes de estoque: {len(mov)} | ruptura: {len(ruptura)} | "
        f"abaixo do minimo: {len(abaixo_min)} | parados 90d: {len(parados)}"
    )


if __name__ == "__main__":
    main()
