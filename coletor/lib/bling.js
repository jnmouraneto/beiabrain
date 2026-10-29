// Cliente da API v3 do Bling com renovacao de token guardada no Redis.
//
// O Bling ROTACIONA o refresh token a cada renovacao (o anterior deixa de valer). Por isso:
//  - o refresh token novo e gravado no Redis ANTES de qualquer outra coisa;
//  - so uma execucao por vez pode renovar (lock no Redis, ver lib/store.js).

const API = "https://api.bling.com.br/Api/v3";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export class Bling {
  /**
   * @param {{store: import('./store.js').Store, clientId: string, clientSecret: string,
   *          pausaMs?: number, prazo: number}} opts  prazo = timestamp (ms) limite da execucao
   */
  constructor({ store, clientId, clientSecret, pausaMs = 400, prazo }) {
    if (!clientId || !clientSecret) throw new Error("Defina BLING_CLIENT_ID e BLING_CLIENT_SECRET.");
    this.store = store;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.pausaMs = pausaMs;
    this.prazo = prazo;
    this.access = null;
  }

  restante() {
    return this.prazo - Date.now();
  }

  async _renovar() {
    const refresh = await this.store.lerRefreshToken();
    if (!refresh) {
      throw new Error("Sem refresh token no Redis. Grave o inicial com: npm run semear-token");
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const r = await fetch(`${API}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 200);
      throw new Error(`Falha ao renovar token (${r.status}): ${txt}`);
    }
    const j = await r.json();
    // 1) grava o refresh novo imediatamente; 2) cacheia o access token ate perto de expirar.
    await this.store.gravarRefreshToken(j.refresh_token);
    const ttl = Math.max(60, (j.expires_in ?? 21600) - 300);
    await this.store.gravarAccessToken(j.access_token, ttl);
    this.access = j.access_token;
  }

  async iniciar() {
    this.access = await this.store.lerAccessToken();
    if (!this.access) await this._renovar();
  }

  async get(caminho, params = {}) {
    let renovou = false;
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      if (this.restante() < 3000) throw new Error("Tempo da funcao esgotado");
      if (this.pausaMs) await dormir(this.pausaMs);
      const url = new URL(API + caminho);
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
        else url.searchParams.set(k, v);
      }
      const r = await fetch(url, { headers: { Authorization: `Bearer ${this.access}` } });
      if (r.status === 401 && !renovou) {
        renovou = true;
        await this._renovar();
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        await dormir(this.pausaMs ? 2000 * (tentativa + 1) : 1);
        continue;
      }
      if (!r.ok) throw new Error(`Bling ${r.status} em ${caminho}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
    throw new Error(`Falha repetida em ${caminho}`);
  }

  async *paginar(caminho, params = {}, limite = 100) {
    for (let pagina = 1; ; pagina++) {
      const { data = [] } = await this.get(caminho, { ...params, pagina, limite });
      if (!data.length) return;
      yield* data;
      if (data.length < limite) return;
    }
  }
}
