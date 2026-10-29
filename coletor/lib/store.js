// Estado persistente (Redis) e publicacao dos dados no GitHub.
// A Vercel nao tem disco persistente: tudo que precisa sobreviver entre execucoes fica aqui.
import { gzipSync } from "node:zlib";

const K = {
  refresh: "bling:refresh_token",
  access: "bling:access_token",
  lock: "bling:lock",
  detalhes: "bling:detalhes", // hash: id -> {estoque_min, custo}
  cursor: "bling:detalhes_cursor", // ultimo id de produto com detalhe buscado
};

export class Store {
  /** @param {{redis: any, github?: {token: string, repo: string, branch?: string}}} opts */
  constructor({ redis, github }) {
    this.redis = redis;
    this.github = github;
  }

  // ---- tokens ----
  lerRefreshToken() {
    return this.redis.get(K.refresh);
  }
  gravarRefreshToken(t) {
    return this.redis.set(K.refresh, t); // sem TTL: o Bling define a validade (~30 dias)
  }
  lerAccessToken() {
    return this.redis.get(K.access);
  }
  gravarAccessToken(t, ttlSeg) {
    return this.redis.set(K.access, t, { ex: ttlSeg });
  }

  // ---- lock: impede duas execucoes simultaneas rotacionando o token ----
  async adquirirLock(segundos = 330) {
    const r = await this.redis.set(K.lock, String(Date.now()), { nx: true, ex: segundos });
    return r === "OK";
  }
  liberarLock() {
    return this.redis.del(K.lock);
  }

  // ---- detalhes de produto (estoque minimo e custo), acumulados ao longo dos dias ----
  async lerDetalhes() {
    const h = (await this.redis.hgetall(K.detalhes)) ?? {};
    const m = new Map();
    for (const [id, v] of Object.entries(h)) {
      const o = typeof v === "string" ? JSON.parse(v) : v;
      m.set(Number(id), o);
    }
    return m;
  }
  gravarDetalhe(id, d) {
    return this.redis.hset(K.detalhes, { [id]: JSON.stringify(d) });
  }
  async lerCursor() {
    return Number((await this.redis.get(K.cursor)) ?? 0);
  }
  gravarCursor(id) {
    return this.redis.set(K.cursor, id);
  }

  // ---- publicar no GitHub ----
  // Coleta diaria: dados/entrada/AAAA-MM-DD.json.gz (dispara o workflow da rotina diaria).
  publicarEntrada(dataISO, conteudo) {
    return this.publicarArquivo(`dados/entrada/${dataISO}.json.gz`, conteudo, `Coleta Bling ${dataISO}`);
  }
  // Historico de vendas: dados/historico/vendas-AAAA-MM-DD.json.gz (dispara so a importacao).
  publicarHistorico(ateISO, conteudo) {
    return this.publicarArquivo(
      `dados/historico/vendas-${ateISO}.json.gz`, conteudo, `Historico de vendas ate ${ateISO}`);
  }

  async publicarArquivo(caminho, conteudo, mensagem) {
    if (!this.github?.token || !this.github?.repo) {
      throw new Error("Defina GITHUB_TOKEN e GITHUB_REPO para publicar os dados.");
    }
    const { token, repo, branch = "main" } = this.github;
    const url = `https://api.github.com/repos/${repo}/contents/${caminho}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "beiabrain-coletor",
    };
    // Se o arquivo do dia ja existe (reexecucao), a API exige o sha dele para sobrescrever.
    let sha;
    const atual = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
    if (atual.ok) sha = (await atual.json()).sha;
    else if (atual.status !== 404) throw new Error(`GitHub GET ${atual.status}`);

    const gz = gzipSync(Buffer.from(JSON.stringify(conteudo)));
    const r = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: mensagem,
        content: gz.toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!r.ok) throw new Error(`GitHub PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { caminho, bytes: gz.length };
  }
}
