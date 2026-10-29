"""Utilitarios compartilhados entre os scripts."""
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# BEIA_ROOT permite apontar para outra pasta (usado nos testes).
ROOT = Path(os.environ.get("BEIA_ROOT", Path(__file__).resolve().parent.parent))
DADOS = ROOT / "dados"
BRUTO = DADOS / "bruto"
DIARIO = DADOS / "diario"
DB_PATH = DADOS / "empresa.db"
DEMANDAS = ROOT / "demandas" / "demandas.json"
PLACAR = ROOT / "demandas" / "placar.json"

TZ = ZoneInfo("America/Sao_Paulo")

SCHEMA = """
CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY,
    codigo TEXT,
    nome TEXT,
    preco REAL,
    custo REAL,
    estoque_min REAL,
    situacao TEXT,
    primeira_vez TEXT
);
CREATE INDEX IF NOT EXISTS ix_produtos_codigo ON produtos(codigo);

CREATE TABLE IF NOT EXISTS saldos (
    data TEXT,
    produto_id INTEGER,
    saldo REAL,
    PRIMARY KEY (data, produto_id)
);

CREATE TABLE IF NOT EXISTS movimentos (
    data TEXT,
    produto_id INTEGER,
    saldo_anterior REAL,
    saldo_novo REAL,
    delta REAL,
    PRIMARY KEY (data, produto_id)
);

CREATE TABLE IF NOT EXISTS precos_hist (
    data TEXT,
    produto_id INTEGER,
    preco_anterior REAL,
    preco_novo REAL,
    PRIMARY KEY (data, produto_id)
);

CREATE TABLE IF NOT EXISTS vendas_itens (
    pedido_id INTEGER,
    data TEXT,
    cliente_id INTEGER,
    produto_id INTEGER,
    quantidade REAL,
    valor_unit REAL,
    PRIMARY KEY (pedido_id, produto_id)
);
CREATE INDEX IF NOT EXISTS ix_vendas_data ON vendas_itens(data);

CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY,
    nome TEXT,
    tipo TEXT,
    doc_hash TEXT,
    primeira_vez TEXT
);
"""


def hoje() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d")


def conectar() -> sqlite3.Connection:
    DADOS.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def ler_json(caminho: Path, padrao=None):
    if not caminho.exists():
        return padrao
    return json.loads(caminho.read_text(encoding="utf-8"))


def gravar_json(caminho: Path, dados) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(
        json.dumps(dados, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
