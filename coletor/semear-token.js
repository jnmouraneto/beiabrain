// Grava o refresh token INICIAL do Bling no Redis (so na primeira vez).
// Uso: BLING_REFRESH_TOKEN=... UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npm run semear-token
// (as variaveis do Redis saem de `vercel env pull .env.local`; KV_REST_API_* tambem funcionam)
import { Redis } from "@upstash/redis";

const token = process.env.BLING_REFRESH_TOKEN;
if (!token) {
  console.error("Defina BLING_REFRESH_TOKEN.");
  process.exit(1);
}
const redis = Redis.fromEnv();
const existente = await redis.get("bling:refresh_token");
if (existente && process.argv[2] !== "--forcar") {
  console.error("Ja existe um refresh token no Redis. Use --forcar para substituir.");
  process.exit(1);
}
await redis.set("bling:refresh_token", token);
await redis.del("bling:access_token");
console.log("Refresh token gravado no Redis.");
