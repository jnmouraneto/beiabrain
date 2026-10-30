// Coleta e normaliza os dados do Bling (API v3) no formato que scripts/gerar_diff.py consome.
// Campos conferidos na especificacao OpenAPI oficial do Bling em 29/10/2026.
import { createHash } from "node:crypto";

export function hashDoc(doc) {
  const limpo = String(doc ?? "").replace(/\D/g, "");
  if (!limpo) return "";
  return createHash("sha256").update(limpo).digest("hex").slice(0, 16);
}

const num = (v) => Number(v ?? 0) || 0;

// Produtos ------------------------------------------------------------------------------------
// /produtos ja devolve preco, precoCusto e estoque.saldoVirtualTotal, entao nao ha chamada de saldos.
//
// Duas protecoes, porque a spec define filtroSaldoEstoque com padrao 1 ("saldo positivo") e nao diz
// se a lista omite os zerados quando o parametro nao e enviado:
//  - consulta com os tres filtros (1 positivo, 0 zerado, 2 negativo) e junta por id;
//  - consulta tipo P e tipo V (variacoes), porque nao esta documentado se P inclui as variacoes.
// Produto "pai" (formato V sem idProdutoPai) nao tem estoque proprio: sai, para nao virar falso "parado".
const TIPOS = ["P", "V"];
const FILTROS_SALDO = [1, 0, 2];

export async function coletarProdutos(b, detalhes = new Map()) {
  const porId = new Map();
  for (const tipo of TIPOS) {
    for (const filtro of FILTROS_SALDO) {
      // criterio 2 = ativos
      const it = b.paginar("/produtos", { criterio: 2, tipo, filtroSaldoEstoque: filtro });
      for await (const p of it) {
        if (porId.has(p.id)) continue;
        if (p.tipo && p.tipo !== "P") continue; // servicos (S, N) nao tem estoque
        if (p.formato === "V" && !p.idProdutoPai) continue; // pai de variacoes
        const d = detalhes.get(p.id);
        porId.set(p.id, {
          id: p.id,
          codigo: p.codigo || "",
          nome: p.nome || "",
          preco: num(p.preco),
          custo: num(p.precoCusto) || d?.custo || 0,
          estoque_min: d?.estoque_min || 0,
          situacao: p.situacao || "A",
          _saldo: num(p.estoque?.saldoVirtualTotal),
        });
      }
    }
  }
  const produtos = [];
  const saldos = [];
  for (const { _saldo, ...p } of porId.values()) {
    produtos.push(p);
    saldos.push({ produto_id: p.id, saldo: _saldo });
  }
  return { produtos, saldos };
}

// Vendas e clientes ---------------------------------------------------------------------------
// O pedido ja traz o contato (nome, tipoPessoa, documento): os clientes vem dos pedidos, o que
// dispensa a rota /contatos (e o escopo "Contatos"). CPF/CNPJ vira hash; telefone/e-mail nao sao lidos.
// ignorarSituacoes: ids de situacao (ex.: cancelado) que nao devem entrar na analise.
export async function coletarVendas(b, dias, hojeISO, ignorarSituacoes = new Set()) {
  const fim = new Date(hojeISO + "T12:00:00Z");
  const ini = new Date(fim.getTime() - dias * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const vendas = [];
  const clientes = new Map();
  const situacoes = {}; // contagem por situacao, para o CEO/voce descobrir o que e "cancelado"
  for await (const v of b.paginar("/pedidos/vendas", {
    dataInicial: iso(ini),
    dataFinal: iso(fim),
  })) {
    const sid = v.situacao?.id ?? null;
    situacoes[sid] = (situacoes[sid] ?? 0) + 1;
    if (sid !== null && ignorarSituacoes.has(Number(sid))) continue;

    const det = (await b.get(`/pedidos/vendas/${v.id}`)).data ?? {};
    const itens = (det.itens ?? [])
      .filter((it) => it.produto?.id)
      .map((it) => ({
        produto_id: it.produto.id,
        quantidade: num(it.quantidade),
        valor: num(it.valor),
      }));
    const c = v.contato;
    if (c?.id && !clientes.has(c.id)) {
      const doc = String(c.numeroDocumento ?? "").replace(/\D/g, "");
      clientes.set(c.id, {
        id: c.id,
        nome: c.nome || "",
        tipo: c.tipoPessoa || (doc.length === 14 ? "J" : doc.length === 11 ? "F" : ""),
        doc_hash: hashDoc(doc),
      });
    }
    vendas.push({
      id: v.id,
      data: String(v.data ?? "").slice(0, 10),
      cliente_id: c?.id ?? null,
      total: num(v.total),
      situacao_id: sid,
      itens,
    });
  }
  return { vendas, clientes: [...clientes.values()], situacoes };
}

// Detalhes -------------------------------------------------------------------------------------
// So o estoque minimo exige GET /produtos/{id} (a lista nao traz). Busca aos poucos, nos minutos
// que sobram da execucao, e continua de onde parou no dia seguinte.
export async function coletarDetalhes(b, ids, store, margemMs = 8000) {
  let feitos = 0;
  let ultimo = null;
  for (const id of ids) {
    if (b.restante() < margemMs) break;
    const d = (await b.get(`/produtos/${id}`)).data ?? {};
    await store.gravarDetalhe(id, {
      estoque_min: num(d.estoque?.minimo),
      custo: num(d.fornecedor?.precoCusto),
    });
    feitos++;
    ultimo = id;
  }
  return { feitos, ultimo };
}
