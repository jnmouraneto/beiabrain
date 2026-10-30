// Orquestra uma execucao diaria: coleta -> publica no GitHub -> usa o tempo que sobrar
// para buscar detalhes (estoque minimo e custo) de alguns produtos.
import { Bling } from "./bling.js";
import { coletarDetalhes, coletarProdutos, coletarVendas } from "./coletores.js";

// BLING_SITUACOES_IGNORAR="12345,67890": ids das situacoes de pedido a descartar (ex.: cancelado).
// A resposta da coleta lista as situacoes encontradas (campo "situacoes") para voce descobrir os ids.
const idsIgnorados = (env) =>
  new Set(String(env.BLING_SITUACOES_IGNORAR ?? "").split(",").map((x) => Number(x.trim())).filter(Boolean));

export const LIMITE_MS = 280_000; // Hobby: 300 s no maximo. Deixa folga para responder.

export function hojeSaoPaulo(agora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

/**
 * Carga de historico: so vendas de uma janela [ate - dias, ate]. Nao mexe em produtos, saldos nem
 * clientes (o saldo de hoje nao pode ser gravado com data antiga). Cada chamada precisa caber em
 * ~280 s: com ~0,4 s por pedido, janelas de 7 dias sao seguras para loja com poucas dezenas de
 * pedidos por dia; se estourar o tempo nada e publicado e basta repetir com menos dias.
 */
export async function executarHistorico({ store, env, ate, dias = 7, pausaMs, limiteMs = LIMITE_MS }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
    return { status: 400, corpo: { erro: "Parametro 'ate' deve ser AAAA-MM-DD." } };
  }
  if (!(await store.adquirirLock(Math.ceil(limiteMs / 1000) + 50))) {
    return { status: 409, corpo: { erro: "Ja existe uma execucao em andamento." } };
  }
  const inicio = Date.now();
  try {
    const b = new Bling({
      store,
      clientId: env.BLING_CLIENT_ID,
      clientSecret: env.BLING_CLIENT_SECRET,
      pausaMs,
      prazo: inicio + limiteMs,
    });
    await b.iniciar();
    const { vendas, clientes, situacoes } = await coletarVendas(b, dias, ate, idsIgnorados(env));
    const arquivo = await store.publicarHistorico(ate, { ate, dias, vendas, clientes });
    return {
      status: 200,
      corpo: {
        arquivo: arquivo.caminho,
        ate,
        dias,
        pedidos: vendas.length,
        situacoes,
        duracao_s: Math.round((Date.now() - inicio) / 1000),
      },
    };
  } finally {
    await store.liberarLock();
  }
}

/**
 * @param {{store: import('./store.js').Store, env: Record<string,string|undefined>,
 *          dias?: number, detalhes?: boolean, pausaMs?: number, limiteMs?: number}} p
 */
export async function executar({ store, env, dias, detalhes = true, pausaMs, limiteMs = LIMITE_MS }) {
  if (!(await store.adquirirLock(Math.ceil(limiteMs / 1000) + 50))) {
    return { status: 409, corpo: { erro: "Ja existe uma execucao em andamento." } };
  }
  const inicio = Date.now();
  try {
    const data = hojeSaoPaulo();
    const b = new Bling({
      store,
      clientId: env.BLING_CLIENT_ID,
      clientSecret: env.BLING_CLIENT_SECRET,
      pausaMs,
      prazo: inicio + limiteMs,
    });
    await b.iniciar();

    const cacheDetalhes = await store.lerDetalhes();
    const { produtos, saldos } = await coletarProdutos(b, cacheDetalhes);
    const janela = dias ?? (Number(env.VENDAS_DIAS) || 2);
    const { vendas, clientes, situacoes } = await coletarVendas(b, janela, data, idsIgnorados(env));

    const arquivo = await store.publicarEntrada(data, { data, produtos, saldos, clientes, vendas });

    const resumo = {
      data,
      arquivo: arquivo.caminho,
      bytes: arquivo.bytes,
      produtos: produtos.length,
      saldos: saldos.length,
      clientes: clientes.length,
      pedidos: vendas.length,
      situacoes,
      detalhes_em_cache: cacheDetalhes.size,
    };

    // Com o tempo que sobrou, busca detalhes de alguns produtos (continua de onde parou).
    if (detalhes) {
      try {
        const cursor = await store.lerCursor();
        const ids = produtos.map((p) => p.id).sort((x, y) => x - y);
        const fila = [...ids.filter((id) => id > cursor), ...ids.filter((id) => id <= cursor)];
        const { feitos, ultimo } = await coletarDetalhes(b, fila, store);
        if (ultimo !== null) await store.gravarCursor(ultimo);
        resumo.detalhes_buscados_agora = feitos;
      } catch (e) {
        // Os dados do dia ja foram publicados; falha aqui nao invalida a coleta.
        resumo.detalhes_erro = String(e.message ?? e);
      }
    }
    resumo.duracao_s = Math.round((Date.now() - inicio) / 1000);
    return { status: 200, corpo: resumo };
  } finally {
    await store.liberarLock();
  }
}
