// Teste de ponta a ponta com Bling, Redis e GitHub SIMULADOS (nenhuma rede real).
// Rodar: npm test   |   TEST_OUT=/pasta npm test  (grava o arquivo publicado para conferir no Python)
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, beforeEach } from "node:test";
import { gunzipSync } from "node:zlib";

import handler from "../api/coletar.js";
import { Bling } from "../lib/bling.js";
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

// ---------- Bling + GitHub falsos (via fetch global) ----------
const N_PRODUTOS = 250; // 3 paginas de 100: exercita a paginacao
const hoje = hojeSaoPaulo();
let st;

function resetar() {
  st = {
    refreshValido: "R0",
    accessValido: "A0",
    renovacoes: 0,
    detalhesPedidos: [],
    chamadasVendas: [],
    rotas: [],
    github: new Map(), // caminho -> {sha, content}
    githubPuts: 0,
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

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
    assert.equal(u.searchParams.get("criterio"), "2");
    const todos = Array.from({ length: N_PRODUTOS }, (_, i) => ({
      id: 1000 + i + 1,
      codigo: `SKU-${String(i + 1).padStart(3, "0")}`,
      nome: `Produto ${i + 1}`,
      preco: 10 + i,
      situacao: "A",
    }));
    return json({ data: fatia(todos) });
  }
  let m;
  if ((m = rota.match(/^\/produtos\/(\d+)$/))) {
    const id = Number(m[1]);
    st.detalhesPedidos.push(id);
    return json({ data: { id, estoque: { minimo: 5 }, fornecedor: { precoCusto: 3.5 } } });
  }
  if (rota === "/estoques/saldos") {
    const ids = u.searchParams.getAll("idsProdutos[]").map(Number);
    assert.ok(ids.length <= 100);
    return json({
      data: ids.map((id) => ({ produto: { id }, saldoFisicoTotal: id % 50, saldoVirtualTotal: id % 50 })),
    });
  }
  if (rota === "/contatos") {
    const todos = Array.from({ length: 130 }, (_, i) => ({
      id: 5000 + i,
      nome: `Cliente ${i}`,
      tipo: "J",
      numeroDocumento: `12.345.678/0001-${String(i).padStart(2, "0")}`,
      telefone: "91999999999", // nao deve aparecer na saida
      email: "x@y.com", // nao deve aparecer na saida
    }));
    return json({ data: fatia(todos) });
  }
  if (rota === "/pedidos/vendas") {
    st.chamadasVendas.push({
      ini: u.searchParams.get("dataInicial"),
      fim: u.searchParams.get("dataFinal"),
    });
    const todos = Array.from({ length: 7 }, (_, i) => ({
      id: 9000 + i,
      data: `${hoje} 10:00:00`,
      total: 50,
      contato: { id: 5000 + i },
    }));
    return json({ data: fatia(todos) });
  }
  if ((m = rota.match(/^\/pedidos\/vendas\/(\d+)$/))) {
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

function novoStore() {
  redis = new FakeRedis();
  store = new Store({ redis, github: { token: "ghtoken", repo: "dono/repo" } });
}
const opcoes = { pausaMs: 0, limiteMs: 20_000 };
const lerPublicado = () => {
  const f = st.github.get(`dados/entrada/${hoje}.json.gz`);
  assert.ok(f, "arquivo do dia nao foi publicado");
  return JSON.parse(gunzipSync(Buffer.from(f.content, "base64")).toString());
};

beforeEach(() => {
  resetar();
  novoStore();
});

// ---------- testes ----------
test("primeira execucao: coleta tudo, rotaciona token, publica e busca detalhes", async () => {
  await redis.set("bling:refresh_token", "R0");
  const { status, corpo } = await executar({ store, env, ...opcoes });
  assert.equal(status, 200, JSON.stringify(corpo));
  assert.equal(corpo.produtos, N_PRODUTOS);
  assert.equal(corpo.saldos, N_PRODUTOS);
  assert.equal(corpo.clientes, 130);
  assert.equal(corpo.pedidos, 7);
  assert.equal(corpo.detalhes_buscados_agora, N_PRODUTOS); // sobrou tempo para todos
  assert.equal(corpo.detalhes_erro, undefined);

  // token rotacionado e guardado; lock liberado
  assert.equal(await redis.get("bling:refresh_token"), "R1");
  assert.equal(await redis.get("bling:lock"), null);

  const pub = lerPublicado();
  assert.equal(pub.data, hoje);
  assert.equal(pub.produtos.length, N_PRODUTOS);
  assert.deepEqual(Object.keys(pub.produtos[0]).sort(),
    ["codigo", "custo", "estoque_min", "id", "nome", "preco", "situacao"]);
  assert.equal(pub.vendas[0].data, hoje); // "AAAA-MM-DD hh:mm:ss" -> "AAAA-MM-DD"
  assert.equal(pub.vendas[0].itens.length, 2); // item sem produto descartado
  // privacidade: sem telefone/e-mail/documento em claro
  const bruto = JSON.stringify(pub);
  assert.ok(!bruto.includes("91999999999") && !bruto.includes("x@y.com") && !bruto.includes("12.345.678"));
  assert.match(pub.clientes[0].doc_hash, /^[0-9a-f]{16}$/);
  // janela de vendas de 2 dias terminando hoje
  const ini = new Date(Date.parse(hoje + "T12:00:00Z") - 2 * 86400000).toISOString().slice(0, 10);
  assert.deepEqual(st.chamadasVendas[0], { ini, fim: hoje });

  if (process.env.TEST_OUT) {
    mkdirSync(`${process.env.TEST_OUT}/dados/entrada`, { recursive: true });
    writeFileSync(`${process.env.TEST_OUT}/dados/entrada/${hoje}.json.gz`,
      Buffer.from(st.github.get(`dados/entrada/${hoje}.json.gz`).content, "base64"));
  }
});

test("segunda execucao no mesmo dia: sobrescreve com sha e usa detalhes em cache", async () => {
  await redis.set("bling:refresh_token", "R0");
  await executar({ store, env, ...opcoes });
  const r2 = await executar({ store, env, ...opcoes });
  assert.equal(r2.status, 200, JSON.stringify(r2.corpo));
  assert.equal(st.githubPuts, 2); // 2o PUT so passa com o sha correto
  assert.equal(r2.corpo.detalhes_em_cache, N_PRODUTOS);
  const pub = lerPublicado();
  assert.equal(pub.produtos[0].estoque_min, 5);
  assert.equal(pub.produtos[0].custo, 3.5);
  // access token foi reaproveitado do cache: so houve 1 renovacao na 1a execucao
  assert.equal(st.renovacoes, 1);
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

test("sem refresh token no Redis: orienta a semear", async () => {
  await assert.rejects(() => executar({ store, env, ...opcoes }), /semear-token/);
  assert.equal(await redis.get("bling:lock"), null);
});

test("detalhes retomam do cursor e dao a volta na lista", async () => {
  await redis.set("bling:refresh_token", "R0");
  await redis.set("bling:detalhes_cursor", 1200);
  const { status } = await executar({ store, env, ...opcoes });
  assert.equal(status, 200);
  assert.equal(st.detalhesPedidos[0], 1201); // comeca logo depois do cursor
  assert.equal(st.detalhesPedidos[49], 1250); // 50 ids restam depois do cursor (1201..1250)...
  assert.equal(st.detalhesPedidos[50], 1001); // ...e volta ao inicio
  assert.equal(st.detalhesPedidos.length, N_PRODUTOS);
});

test("detalhes param quando o tempo acaba e o cursor guarda onde parou", async () => {
  let chamadas = 0;
  const b = {
    restante: () => (chamadas < 10 ? 100_000 : 0),
    get: async (c) => {
      chamadas++;
      return { data: { estoque: { minimo: 1 }, precoCusto: 2 } };
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

test("historico: publica so vendas de uma janela antiga, sem tocar em produtos e saldos", async () => {
  await redis.set("bling:refresh_token", "R0");
  const ate = "2026-09-15";
  const { status, corpo } = await executarHistorico({ store, env, ate, dias: 7, ...opcoes });
  assert.equal(status, 200, JSON.stringify(corpo));
  assert.equal(corpo.arquivo, `dados/historico/vendas-${ate}.json.gz`);
  assert.equal(corpo.pedidos, 7);
  assert.deepEqual(st.chamadasVendas[0], { ini: "2026-09-08", fim: ate });
  // nenhuma chamada a produtos, saldos ou contatos: o saldo de hoje nao pode ganhar data antiga
  for (const r of ["/produtos", "/estoques/saldos", "/contatos"]) {
    assert.ok(!st.rotas.some((x) => x.startsWith(r)), `nao deveria chamar ${r}`);
  }
  assert.equal(st.github.has(`dados/entrada/${hoje}.json.gz`), false); // nao dispara a rotina diaria
  const f = st.github.get(`dados/historico/vendas-${ate}.json.gz`);
  const pub = JSON.parse(gunzipSync(Buffer.from(f.content, "base64")).toString());
  assert.deepEqual(Object.keys(pub).sort(), ["ate", "dias", "vendas"]);
  assert.equal(pub.vendas.length, 7);
  assert.equal(await redis.get("bling:lock"), null);

  if (process.env.TEST_OUT) {
    mkdirSync(`${process.env.TEST_OUT}/dados/historico`, { recursive: true });
    writeFileSync(`${process.env.TEST_OUT}/dados/historico/vendas-${ate}.json.gz`,
      Buffer.from(f.content, "base64"));
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
