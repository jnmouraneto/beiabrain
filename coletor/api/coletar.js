// Endpoint chamado pelo Vercel Cron (ver vercel.json). Tambem pode ser chamado a mao:
//   curl -H "Authorization: Bearer $CRON_SECRET" "https://SEU-PROJETO.vercel.app/api/coletar?dias=7"
import { Redis } from "@upstash/redis";
import { executar, executarHistorico } from "../lib/executar.js";
import { Store } from "../lib/store.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  const segredo = process.env.CRON_SECRET;
  if (!segredo) return res.status(500).json({ erro: "CRON_SECRET nao configurado." });
  if (req.headers.authorization !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: "Nao autorizado." });
  }

  try {
    const store = new Store({
      redis: Redis.fromEnv(),
      github: { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO },
    });
    const dias = req.query?.dias ? Number(req.query.dias) : undefined;
    // ?ate=AAAA-MM-DD&dias=7  -> carga de historico (so vendas). Sem 'ate' -> coleta diaria.
    if (req.query?.ate) {
      const r = await executarHistorico({ store, env: process.env, ate: req.query.ate, dias });
      return res.status(r.status).json(r.corpo);
    }
    const detalhes = req.query?.detalhes !== "0";
    const { status, corpo } = await executar({ store, env: process.env, dias, detalhes });
    return res.status(status).json(corpo);
  } catch (e) {
    console.error("Falha na coleta:", e);
    return res.status(500).json({ erro: String(e.message ?? e) });
  }
}
