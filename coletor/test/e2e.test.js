// Teste de ponta a ponta com Bling, Redis e GitHub SIMULADOS (nenhuma rede real).
// O Bling simulado segue a especificacao OpenAPI oficial e e propositalmente adversarial:
//  - sem filtroSaldoEstoque, a lista omite produtos zerados e negativos (pior caso do padrao "1");
//  - tipo=P devolve simples, o produto "pai" e um servico; as variacoes so aparecem em tipo=V.
// Rodar: npm test   |   TEST_OUT=/pasta npm test  (grava os arquivos publicados para o teste Python)
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, beforeEach } from "node:test";
import { gunzipSync } from "node:zlib";

import handler from "../api/coletar.js";
import { coletarDetalhes } from "../lib/coletores.js";
import { executar, executarHistorico, hojeSaoPaulo } from "../lib/executar.js";
import { Store } from "../lib/store.js";

// ---------- Redis falso ----------
class FakeRedis {
  constructor() {
    this.m = new Map();
    this.h = new Map();
  }
  async get(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  async set(k, v, o = {}) {
    if (o.nx && this.m.has(k)) return null;
    this.m.set(k, v);
    return "OK";
  }
  async del(k) {
    this.m.delete(k);
    return 1;
  }
  async hgetall(k) {
    const h = this.h.get(k);
    return h ? Object.fromEntries(h) : null;
  }
  async hset(k, obj) {
    if (!this.h.has(k)) this.h.set(k, new Map());
    for (const [f, v] of Object.entries(obj)) this.h.get(k).set(f, v);
    return 1;
  }
}

// ---------- catalogo do Bling simulado ----------
const N_SIMPLES = 250; // ids 1001..1250: 3 paginas de 100 (exercita a paginacao)
const IDS_VALIDOS = 252; // 250 simples + 2 variacoes; o pai (3000) e o servico (4000) ficam de fora
const saldoDe = (id) => (id === 1003 ? -2 : id % 50); // 1050, 1100... zerados; 1003 negativo

const simples = Array.from({ length: N_SIMPLES }, (_, i) => {
  const id = 1000 + i + 1;
  return {
    id, codigo: `SKU-${String(i + 1).padStart(3, "0")}`, nome: `Produto ${i + 1}`,
    preco: 10 + i, precoCusto: 4, tipo: "P", formato: "S", situacao: "A",
    estoque: { saldoVirtualTotal: saldoDe(id) },
  };
});
const pai = { id: 3000, codigo: "PAPEL-COR", nome: "Papel Color (pai)", preco: 8.5, precoCusto: 4,
  tipo: "P", formato: "V", situacao: "A", estoque: { saldoVirtualTotal: 7 } };
const variacoes = [
  { id: 3001, idProdutoPai: 3000, codigo: "PAPEL-COR-AZ", nome: "Papel Color Azul", preco: 8.5,
    precoCusto: 4, tipo: "P", formato: "S", situacao: "A", estoque: { saldoVirtualTotal: 7 } },
  { id: 3002, idProdutoPai: 3000, codigo: "PAPEL-COR-VD", nome: "Papel Color Verde", preco: 8.5,
    precoCusto: 4, tipo: "P", formato: "S", situacao: "A", estoque: { saldoVirtualTotal: 0 } },
];
const servico = { id: 4000, codigo: "SRV", nome: "Servico de impressao", preco: 5, tipo: "S",
  formato: "S", situacao: "A", estoque: { saldoVirtualTotal: 0 } };

const hoje = hojeSaoPaulo();
let st;

function resetar() {
  st = {
    refreshValido: "R0", accessValido: "A0", renovacoes: 0,
    detalhesPedidos: [], pedidoDetalhes: [], chamadasVendas: [], rotas: [], consultasProdutos: [],
    github: new Map(), githubPuts: 0,
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const classe = (s) => (s > 0 ? 1 : s === 0 ? 0 : 2); // filtroSaldoEstoque: 1 positivo, 0 zerado, 2 negativo

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const metodo = init.method ?? "GET";
  const auth = init.headers?.Authorization ?? init.headers?.authorization;

  // ---- GitHub ----
  if (u.host === "api.github.com") {
    assert.equal(auth, "Bearer ghtoken");
    const caminho = u.pathname.replace("/repos/dono/repo/contents/", "");
    if (metodo === "GET") {
      const f = st.github.get(caminho);
      return f ? json({ sha: f.sha }) : json({ message: "Not Found" }, 404);
    }
    const body = JSON.parse(init.body);
    const f = st.github.get(caminho);
    if (f && body.sha !== f.sha) return json({ message: "sha obrigatorio" }, 422);
    st.githubPuts++;
    st.github.set(caminho, { sha: `sha${st.githubPuts}`, content: body.content, branch: body.branch });
    return json({ ok: true }, f ? 200 : 201);
  }

  // ---- Bling ----
  assert.equal(u.host, "api.bling.com.br");
  const rota = u.pathname.replace("/Api/v3", "");
  st.rotas.push(rota);

  if (rota === "/oauth/token") {
    assert.match(auth, /^Basic /);
    const p = new URLSearchParams(init.body);
    assert.equal(p.get("grant_type"), "refresh_token");
    if (p.get("refresh_token") !== st.refreshValido) return json({ error: "invalid_grant" }, 400);
    st.renovacoes++;
    st.refreshValido = `R${st.renovacoes}`;
    st.accessValido = `A${st.renovacoes}`;
    return json({ access_token: st.accessValido, refresh_token: st.refreshValido, expires_in: 21600 });
  }

  if (auth !== `Bearer ${st.accessValido}`) return json({ error: "unauthorized" }, 401);

  const pagina = Number(u.searchParams.get("pagina") ?? 1);
  const limite = Number(u.searchParams.get("limite") ?? 100);
  const fatia = (arr) => arr.slice((pagina - 1) * limite, pagina * limite);

  if (rota === "/produtos") {
    assert.equal(u.searchParams.get("criterio"), "2"); // ativos
    const tipo = u.searchParams.get("tipo");
    const filtro = Number(u.searchParams.get("filtroSaldoEstoque") ?? 1); // padrao da spec: 1
    st.consultasProdutos.push({ tipo, filtro, pagina });
    const base = tipo === "V" ? variacoes : [...simples, pai, servico];
    return json({ data: fatia(base.filter((p) => classe(p.estoque.saldoVirtualTotal) === filtro)) });
  }
  let m;
  if ((m = rota.match(/^\/produtos\/(\d+)$/))) {
    const id = Number(m[1]);
    st.detalhesPedidos.push(id);
    return json({ data: { id, estoque: { minimo: 5 }, fornecedor: { precoCusto: 3.5 } } });
  }
  if (rota === "/pedidos/vendas") {
    st.chamadasVendas.push({ ini: u.searchParams.get("dataInicial"), fim: u.searchParams.get("dataFinal") });
    const todos = Array.from({ length: 7 }, (_, i) => ({
      id: 9000 + i,
      numero: 100 + i,
      data: hoje, // a API devolve so a data
      total: 50,
      situacao: { id: i === 6 ? 200 : 100, valor: i === 6 ? 2 : 1 }, // 200 = "cancelado"
      contato: {
        id: 5000 + i, nome: `Cliente ${i}`, tipoPessoa: i % 2 ? "F" : "J",
        numeroDocumento: `12.345.678/0001-${String(i).padStart(2, "0")}`,
      },
    }));
    return json({ data: fatia(todos) });
  }
  if ((m = rota.match(/^\/pedidos\/vendas\/(\d+)$/))) {
    st.pedidoDetalhes.push(Number(m[1]));
    return json({
      data: {
        itens: [
          { produto: { id: 1001 }, quantidade: 2, valor: 10 },
          { produto: { id: 1002 }, quantidade: 1, valor: 20 },
          { produto: null, quantidade: 1, valor: 1 }, // item sem produto deve ser ignorado
        ],
      },
    });
  }
  return json({ error: "rota nao simulada: " + rota }, 404);
};

// ---------- helpers ----------
let redis, store;
const env = { BLING_CLIENT_ID: "cid", BLING_CLIENT_SECRET: "sec" };
const opcoes = { pausaMs: 0, limiteMs: 20_000 };

function novoStore() {
  redis = new FakeRedis();
  store = new Store({ redis, github: { token: "ghtoken", repo: "dono/repo" } });
}
const publicado = (caminho) => {
  const f = st.github.get(caminho);
  assert.ok(f, `arquivo nao publicado: ${caminho}`);
  return JSON.parse(gunzipSync(Buffer.from(f.content, "base64")).toString());
};
const lerPublicado = () => publicado(`dados/entrada/${hoje}.json.gz`);

beforeEach(() => {
  resetar();
  novoStore();
});

// ---------- testes ----------
test("primeira execucao: coleta tudo, rotaciona token, publica e busca detalhes", async () => {
  await redis.set("bling:refresh_token", "R0");
  const { status, corpo } = await executar({ store, env, ...opcoes });
  assert.equal(status, 200, JSON.stringify(corpo));
  assert.equal(corpo.produtos, IDS_VALIDOS);
  assert.equal(corpo.saldos, IDS_VALIDOS);
  assert.equal(corpo.clientes, 7);
  assert.equal(corpo.pedidos, 7);
  assert.deepEqual(corpo.situacoes, { 100: 6, 200: 1 }); // mostra as situacoes para voce escolher o que ignorar
  assert.equal(corpo.detalhes_buscados_agora, IDS_VALIDOS);
  assert.equal(corpo.detalhes_erro, undefined);

  assert.equal(await redis.get("bling:refresh_token"), "R1"); // token rotacionado e guardado
  assert.equal(await redis.get("bling:lock"), null);

  const pub = lerPublicado();
  assert.equal(pub.data, hoje);
  assert.deepEqual(Object.keys(pub.produtos[0]).sort(),
    ["codigo", "custo", "estoque_min", "id", "nome", "preco", "situacao"]); // sem campo interno _saldo
  const porId = new Map(pub.produtos.map((p) => [p.id, p]));
  const saldo = new Map(pub.saldos.map((s) => [s.produto_id, s.saldo]));

  // zerados e negativos NAO podem sumir (era o risco do filtro padrao "positivo")
  assert.ok(porId.has(1050) && saldo.get(1050) === 0, "produto zerado precisa estar na coleta");
  assert.ok(porId.has(1003) && saldo.get(1003) === -2, "produto negativo precisa estar na coleta");
  // variacoes entram (tipo V); pai e servico nao
  assert.ok(porId.has(3001) && porId.has(3002), "variacoes precisam entrar");
  assert.ok(!porId.has(3000), "produto pai nao pode entrar (estoque nao e proprio)");
  assert.ok(!porId.has(4000), "servico nao pode entrar");
  assert.equal(saldo.get(3001), 7);
  assert.equal(saldo.get(3002), 0);
  // custo vem da lista; sem duplicados
  assert.equal(porId.get(1001).custo, 4);
  assert.equal(new Set(pub.produtos.map((p) => p.id)).size, pub.produtos.length);
  // as rotas descartadas nao sao mais chamadas
  assert.ok(!st.rotas.includes("/estoques/saldos") && !st.rotas.includes("/contatos"));

  // clientes vem dos pedidos; documento so como hash; sem telefone/e-mail
  assert.equal(pub.clientes.length, 7);
  assert.match(pub.clientes[0].doc_hash, /^[0-9a-f]{16}$/);
  assert.equal(pub.clientes[0].tipo, "J");
  assert.ok(!JSON.stringify(pub).includes("12.345.678"), "documento nao pode aparecer em claro");
  // vendas: data so AAAA-MM-DD, situacao guardada, item sem produto descartado
  assert.equal(pub.vendas[0].data, hoje);
  assert.equal(pub.vendas[0].situacao_id, 100);
  assert.equal(pub.vendas[0].itens.length, 2);
  const ini = new Date(Date.parse(hoje + "T12:00:00Z") - 2 * 86400000).toISOString().slice(0, 10);
  assert.deepEqual(st.chamadasVendas[0], { ini, fim: hoje });

  if (process.env.TEST_OUT) {
    mkdirSync(`${process.env.TEST_OUT}/dados/entrada`, { recursive: true });
    writeFileSync(`${process.env.TEST_OUT}/dados/entrada/${hoje}.json.gz`,
      Buffer.from(st.github.get(`dados/entrada/${hoje}.json.gz`).content, "base64"));
  }
});

test("consulta produtos com os 3 filtros de saldo e os 2 tipos", async () => {
  await redis.set("bling:refresh_token", "R0");
  await executar({ store, env, ...opcoes, detalhes: false });
  const combos = new Set(st.consultasProdutos.map((c) => `${c.tipo}/${c.filtro}`));
  assert.deepEqual([...combos].sort(), ["P/0", "P/1", "P/2", "V/0", "V/1", "V/2"]);
});

test("situacoes ignoradas (ex.: cancelado) nao entram e nem gastam chamada de detalhe", async () => {
  await redis.set("bling:refresh_token", "R0");
  const { corpo } = await executar({
    store, env: { ...env, BLING_SITUACOES_IGNORAR: "200" }, ...opcoes, detalhes: false,
  });
  assert.equal(corpo.pedidos, 6);
  assert.equal(corpo.clientes, 6);
  assert.deepEqual(corpo.situacoes, { 100: 6, 200: 1 }); // a contagem ainda mostra o cancelado
  assert.ok(!st.pedidoDetalhes.includes(9006));
});

test("segunda execucao no mesmo dia: sobrescreve com sha e usa detalhes em cache", async () => {
  await redis.set("bling:refresh_token", "R0");
  await executar({ store, env, ...opcoes });
  const r2 = await executar({ store, env, ...opcoes });
  assert.equal(r2.status, 200, JSON.stringify(r2.corpo));
  assert.equal(st.githubPuts, 2); // 2o PUT so passa com o sha correto
  assert.equal(r2.corpo.detalhes_em_cache, IDS_VALIDOS);
  const p = lerPublicado().produtos.find((x) => x.id === 1001);
  assert.equal(p.estoque_min, 5);
  assert.equal(p.custo, 4);
  assert.equal(st.renovacoes, 1); // access token reaproveitado do cache
});

test("access token expirado (401) renova uma vez e continua", async () => {
  await redis.set("bling:refresh_token", "R0");
  await redis.set("bling:access_token", "A-velho");
  const { status, corpo } = await executar({ store, env, ...opcoes });
  assert.equal(status, 200, JSON.stringify(corpo));
  assert.equal(st.renovacoes, 1);
  assert.equal(await redis.get("bling:refresh_token"), "R1");
});

test("lock: execucao simultanea e recusada e nao toca no token", async () => {
  await redis.set("bling:refresh_token", "R0");
  await redis.set("bling:lock", "x");
  const { status } = await executar({ store, env, ...opcoes });
  assert.equal(status, 409);
  assert.equal(st.renovacoes, 0);
  assert.equal(await redis.get("bling:lock"), "x"); // lock alheio permanece
});

test("refresh token invalido: erro claro e lock liberado", async () => {
  await redis.set("bling:refresh_token", "ERRADO");
  await assert.rejects(() => executar({ store, env, ...opcoes }), /Falha ao renovar token \(400\)/);
  assert.equal(await redis.get("bling:lock"), null);
});

test("semente: usa BLING_REFRESH_TOKEN so quando o Redis esta vazio; depois o Redis manda", async () => {
  const comSemente = { ...env, BLING_REFRESH_TOKEN: "R0" };
  const r1 = await executar({ store, env: comSemente, ...opcoes, detalhes: false });
  assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
  assert.equal(await redis.get("bling:refresh_token"), "R1");
  // variavel de ambiente esquecida (agora invalida) nao pode atrapalhar as proximas execucoes
  await redis.del("bling:access_token");
  const r2 = await executar({ store, env: comSemente, ...opcoes, detalhes: false });
  assert.equal(r2.status, 200, JSON.stringify(r2.corpo));
  assert.equal(await redis.get("bling:refresh_token"), "R2");
});

test("sem refresh token no Redis: orienta a semear", async () => {
  await assert.rejects(() => executar({ store, env, ...opcoes }), /semear-token/);
  assert.equal(await redis.get("bling:lock"), null);
});

test("detalhes retomam do cursor e dao a volta na lista", async () => {
  await redis.set("bling:refresh_token", "R0");
  await redis.set("bling:detalhes_cursor", 1200);
  const { status } = await executar({ store, env, ...opcoes });
  assert.equal(status, 200);
  const d = st.detalhesPedidos;
  assert.equal(d[0], 1201); // comeca logo depois do cursor
  assert.equal(d[49], 1250); // 1201..1250
  assert.equal(d[50], 3001); // depois as variacoes
  assert.equal(d[51], 3002);
  assert.equal(d[52], 1001); // ...e volta ao inicio
  assert.equal(d.length, IDS_VALIDOS);
});

test("detalhes param quando o tempo acaba e o cursor guarda onde parou", async () => {
  let chamadas = 0;
  const b = {
    restante: () => (chamadas < 10 ? 100_000 : 0),
    get: async () => {
      chamadas++;
      return { data: { estoque: { minimo: 1 }, fornecedor: { precoCusto: 2 } } };
    },
  };
  const { feitos, ultimo } = await coletarDetalhes(b, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], store);
  assert.equal(feitos, 10);
  assert.equal(ultimo, 20);
  assert.equal((await store.lerDetalhes()).size, 10);
});

test("estouro de tempo antes de publicar: nada e publicado e o lock e liberado", async () => {
  await redis.set("bling:refresh_token", "R0");
  await assert.rejects(
    () => executar({ store, env, pausaMs: 0, limiteMs: 1 }),
    /Tempo da funcao esgotado/,
  );
  assert.equal(st.github.size, 0);
  assert.equal(await redis.get("bling:lock"), null);
});

test("historico: publica so vendas e clientes de uma janela antiga, sem tocar em produtos", async () => {
  await redis.set("bling:refresh_token", "R0");
  const ate = "2026-09-15";
  const { status, corpo } = await executarHistorico({ store, env, ate, dias: 7, ...opcoes });
  assert.equal(status, 200, JSON.stringify(corpo));
  assert.equal(corpo.arquivo, `dados/historico/vendas-${ate}.json.gz`);
  assert.equal(corpo.pedidos, 7);
  assert.deepEqual(st.chamadasVendas[0], { ini: "2026-09-08", fim: ate });
  // nenhuma chamada a produtos: o saldo de hoje nao pode ganhar data antiga
  assert.ok(!st.rotas.some((x) => x.startsWith("/produtos")), "historico nao deve consultar produtos");
  assert.equal(st.github.has(`dados/entrada/${hoje}.json.gz`), false); // nao dispara a rotina diaria
  const pub = publicado(`dados/historico/vendas-${ate}.json.gz`);
  assert.deepEqual(Object.keys(pub).sort(), ["ate", "clientes", "dias", "vendas"]);
  assert.equal(pub.vendas.length, 7);
  assert.equal(pub.clientes.length, 7);
  assert.equal(await redis.get("bling:lock"), null);

  if (process.env.TEST_OUT) {
    mkdirSync(`${process.env.TEST_OUT}/dados/historico`, { recursive: true });
    writeFileSync(`${process.env.TEST_OUT}/dados/historico/vendas-${ate}.json.gz`,
      Buffer.from(st.github.get(`dados/historico/vendas-${ate}.json.gz`).content, "base64"));
  }
});

test("historico: data invalida retorna 400 sem tocar no Bling", async () => {
  const r = await executarHistorico({ store, env, ate: "15/09/2026", ...opcoes });
  assert.equal(r.status, 400);
  assert.equal(st.rotas.length, 0);
});

test("endpoint: exige CRON_SECRET e Bearer correto", async () => {
  const res = () => {
    const r = { code: null, body: null };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  delete process.env.CRON_SECRET;
  let r = res();
  await handler({ headers: {}, query: {} }, r);
  assert.equal(r.code, 500);

  process.env.CRON_SECRET = "segredo";
  r = res();
  await handler({ headers: {}, query: {} }, r);
  assert.equal(r.code, 401);
  r = res();
  await handler({ headers: { authorization: "Bearer errado" }, query: {} }, r);
  assert.equal(r.code, 401);
});
