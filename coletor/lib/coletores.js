// Coleta e normaliza os dados do Bling no MESMO formato que o scripts/puxar_bling.py gera
// (e que o scripts/gerar_diff.py consome). Qualquer mudanca de formato deve ser feita nos dois.
import { createHash } from "node:crypto";

export function hashDoc(doc) {
  const limpo = String(doc ?? "").replace(/\D/g, "");
  if (!limpo) return "";
  return createHash("sha256").update(limpo).digest("hex").slice(0, 16);
}

const num = (v) => Number(v ?? 0) || 0;

export async function coletarProdutos(b, detalhes = new Map()) {
  const produtos = [];
  // criterio 2 = ativos; tipo P = produtos (nao servicos)
  for await (const p of b.paginar("/produtos", { criterio: 2, tipo: "P" })) {
    const d = detalhes.get(p.id);
    produtos.push({
      id: p.id,
      codigo: p.codigo || "",
      nome: p.nome || "",
      preco: num(p.preco),
      custo: d?.custo || num(p.precoCusto),
      estoque_min: d?.estoque_min || 0,
      situacao: p.situacao || "A",
    });
  }
  return produtos;
}

export async function coletarSaldos(b, produtos) {
  const saldos = [];
  const ids = produtos.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 100) {
    const resp = await b.get("/estoques/saldos", { "idsProdutos[]": ids.slice(i, i + 100) });
    for (const item of resp.data ?? []) {
      saldos.push({
        produto_id: item.produto.id,
        saldo: num(item.saldoVirtualTotal ?? item.saldoFisicoTotal),
      });
    }
  }
  return saldos;
}

export async function coletarClientes(b) {
  const clientes = [];
  for await (const c of b.paginar("/contatos", { criterio: 1 })) {
    clientes.push({
      id: c.id,
      nome: c.nome || "",
      tipo: c.tipo || "",
      // CPF/CNPJ vira hash. Telefone e e-mail nao sao coletados.
      doc_hash: hashDoc(c.numeroDocumento),
    });
  }
  return clientes;
}

export async function coletarVendas(b, dias, hojeISO) {
  const fim = new Date(hojeISO + "T12:00:00Z");
  const ini = new Date(fim.getTime() - dias * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const vendas = [];
  for await (const v of b.paginar("/pedidos/vendas", {
    dataInicial: iso(ini),
    dataFinal: iso(fim),
  })) {
    const det = (await b.get(`/pedidos/vendas/${v.id}`)).data ?? {};
    const itens = (det.itens ?? [])
      .filter((it) => it.produto?.id)
      .map((it) => ({
        produto_id: it.produto.id,
        quantidade: num(it.quantidade),
        valor: num(it.valor),
      }));
    vendas.push({
      id: v.id,
      data: String(v.data ?? "").slice(0, 10),
      cliente_id: v.contato?.id ?? null,
      total: num(v.total),
      itens,
    });
  }
  return vendas;
}

// Busca estoque minimo e custo de alguns produtos por vez (a lista nao traz esses campos).
// Retorna quantos foram processados e o ultimo id, para continuar de onde parou.
export async function coletarDetalhes(b, ids, store, margemMs = 8000) {
  let feitos = 0;
  let ultimo = null;
  for (const id of ids) {
    if (b.restante() < margemMs) break;
    const d = (await b.get(`/produtos/${id}`)).data ?? {};
    await store.gravarDetalhe(id, {
      estoque_min: num(d.estoque?.minimo),
      custo: num(d.fornecedor?.precoCusto) || num(d.precoCusto),
    });
    feitos++;
    ultimo = id;
  }
  return { feitos, ultimo };
}
