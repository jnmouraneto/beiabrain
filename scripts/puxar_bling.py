"""Puxa dados da API v3 do Bling e grava JSON normalizado em dados/bruto/AAAA-MM-DD/.

Variaveis de ambiente:
  BLING_CLIENT_ID, BLING_CLIENT_SECRET   credenciais do app no Bling
  BLING_REFRESH_TOKEN                    refresh token inicial (so na primeira execucao)

O Bling ROTACIONA o refresh token a cada renovacao. O token novo e salvo em
dados/.bling_token.json (ignorado no git) e tem prioridade sobre a variavel de ambiente.
Em CI, o workflow precisa atualizar o secret com o conteudo desse arquivo.

Uso:
  python scripts/puxar_bling.py                 # produtos, saldos, clientes, vendas dos ultimos 2 dias
  python scripts/puxar_bling.py --dias 90       # carga inicial de vendas
  python scripts/puxar_bling.py --detalhes      # busca estoque minimo/custo por produto (lento: ~3 req/s)
"""
import argparse
import base64
import hashlib
import os
import sys
import time
from datetime import datetime, timedelta

import requests

from common import BRUTO, DADOS, TZ, gravar_json, hoje, ler_json

API = "https://api.bling.com.br/Api/v3"
TOKEN_FILE = DADOS / ".bling_token.json"
PAUSA = 0.4  # limite do Bling: 3 req/s


def hash_doc(doc: str) -> str:
    limpo = "".join(c for c in (doc or "") if c.isdigit())
    if not limpo:
        return ""
    return hashlib.sha256(limpo.encode()).hexdigest()[:16]


class Bling:
    def __init__(self):
        self.cid = os.environ.get("BLING_CLIENT_ID")
        self.secret = os.environ.get("BLING_CLIENT_SECRET")
        if not self.cid or not self.secret:
            sys.exit("Defina BLING_CLIENT_ID e BLING_CLIENT_SECRET.")
        self.s = requests.Session()
        self.access = None
        self._renovar()

    def _renovar(self):
        salvo = ler_json(TOKEN_FILE, {}) or {}
        refresh = salvo.get("refresh_token") or os.environ.get("BLING_REFRESH_TOKEN")
        if not refresh:
            sys.exit("Sem refresh token. Defina BLING_REFRESH_TOKEN.")
        basic = base64.b64encode(f"{self.cid}:{self.secret}".encode()).decode()
        r = requests.post(
            f"{API}/oauth/token",
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "refresh_token", "refresh_token": refresh},
            timeout=30,
        )
        if r.status_code != 200:
            sys.exit(f"Falha ao renovar token ({r.status_code}): {r.text[:200]}")
        j = r.json()
        self.access = j["access_token"]
        gravar_json(TOKEN_FILE, {"refresh_token": j["refresh_token"]})
        self.s.headers["Authorization"] = f"Bearer {self.access}"

    def get(self, caminho, params=None):
        for tentativa in range(5):
            time.sleep(PAUSA)
            r = self.s.get(f"{API}{caminho}", params=params, timeout=60)
            if r.status_code == 401 and tentativa == 0:
                self._renovar()
                continue
            if r.status_code == 429:
                time.sleep(2 * (tentativa + 1))
                continue
            if r.status_code >= 500:
                time.sleep(2 * (tentativa + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Falha repetida em {caminho}")

    def paginar(self, caminho, params=None, limite=100):
        pagina = 1
        while True:
            p = dict(params or {})
            p.update({"pagina": pagina, "limite": limite})
            dados = self.get(caminho, p).get("data", [])
            if not dados:
                return
            yield from dados
            if len(dados) < limite:
                return
            pagina += 1


def coletar_produtos(b: Bling, detalhes: bool):
    produtos = []
    for p in b.paginar("/produtos", {"criterio": 2, "tipo": "P"}):  # 2 = ativos
        produtos.append(
            {
                "id": p["id"],
                "codigo": p.get("codigo") or "",
                "nome": p.get("nome") or "",
                "preco": float(p.get("preco") or 0),
                "custo": float(p.get("precoCusto") or 0),
                "estoque_min": 0.0,
                "situacao": p.get("situacao") or "A",
            }
        )
    if detalhes:
        for i, p in enumerate(produtos, 1):
            d = b.get(f"/produtos/{p['id']}").get("data", {})
            est = d.get("estoque") or {}
            p["estoque_min"] = float(est.get("minimo") or 0)
            forn = d.get("fornecedor") or {}
            p["custo"] = float(forn.get("precoCusto") or p["custo"] or 0)
            if i % 100 == 0:
                print(f"  detalhes {i}/{len(produtos)}", flush=True)
    return produtos


def coletar_saldos(b: Bling, produtos):
    saldos = []
    ids = [p["id"] for p in produtos]
    for i in range(0, len(ids), 100):
        lote = ids[i : i + 100]
        resp = b.get("/estoques/saldos", {"idsProdutos[]": lote})
        for item in resp.get("data", []):
            saldos.append(
                {
                    "produto_id": item["produto"]["id"],
                    "saldo": float(item.get("saldoVirtualTotal", item.get("saldoFisicoTotal", 0)) or 0),
                }
            )
    return saldos


def coletar_clientes(b: Bling):
    clientes = []
    for c in b.paginar("/contatos", {"criterio": 1}):
        clientes.append(
            {
                "id": c["id"],
                "nome": c.get("nome") or "",
                "tipo": c.get("tipo") or "",
                # CPF/CNPJ vira hash. Telefone e e-mail nao sao coletados.
                "doc_hash": hash_doc(c.get("numeroDocumento")),
            }
        )
    return clientes


def coletar_vendas(b: Bling, dias: int):
    fim = datetime.now(TZ).date()
    ini = fim - timedelta(days=dias)
    vendas = []
    lista = b.paginar(
        "/pedidos/vendas",
        {"dataInicial": ini.isoformat(), "dataFinal": fim.isoformat()},
    )
    for v in lista:
        det = b.get(f"/pedidos/vendas/{v['id']}").get("data", {})
        itens = [
            {
                "produto_id": (it.get("produto") or {}).get("id"),
                "quantidade": float(it.get("quantidade") or 0),
                "valor": float(it.get("valor") or 0),
            }
            for it in det.get("itens", [])
            if (it.get("produto") or {}).get("id")
        ]
        vendas.append(
            {
                "id": v["id"],
                "data": (v.get("data") or "")[:10],
                "cliente_id": (v.get("contato") or {}).get("id"),
                "total": float(v.get("total") or 0),
                "itens": itens,
            }
        )
    return vendas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dias", type=int, default=2, help="janela de vendas (dias)")
    ap.add_argument("--detalhes", action="store_true", help="busca estoque minimo e custo")
    ap.add_argument("--data", default=hoje())
    args = ap.parse_args()

    b = Bling()
    saida = BRUTO / args.data
    print("Produtos...", flush=True)
    produtos = coletar_produtos(b, args.detalhes)
    gravar_json(saida / "produtos.json", produtos)
    print(f"  {len(produtos)} produtos")
    print("Saldos...", flush=True)
    gravar_json(saida / "saldos.json", coletar_saldos(b, produtos))
    print("Clientes...", flush=True)
    clientes = coletar_clientes(b)
    gravar_json(saida / "clientes.json", clientes)
    print(f"  {len(clientes)} clientes")
    print(f"Vendas dos ultimos {args.dias} dias...", flush=True)
    vendas = coletar_vendas(b, args.dias)
    gravar_json(saida / "vendas.json", vendas)
    print(f"  {len(vendas)} pedidos")
    print(f"Ok: {saida}")


if __name__ == "__main__":
    main()
