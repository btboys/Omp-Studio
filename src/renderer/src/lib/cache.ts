import type { CacheStats, ViewMessage } from "./types";

export type { CacheStats } from "./types";

/** Zeroed stats for threads with no usage data yet. */
export const EMPTY_CACHE_STATS: CacheStats = {
  hitRatio: null,
  recentRatio: null,
  hitCount: 0,
  requestCount: 0,
  cachedTokens: 0,
  totalInput: 0,
  costTotal: 0,
};

const RECENT_WINDOW = 10;

/** Per-request token pair; skips usage entries with no prompt side. */
function requestTokens(m: ViewMessage): { cached: number; fresh: number } | null {
  const u = m.usage;
  if (!u) return null;
  const cached = typeof u.cacheRead === "number" && u.cacheRead > 0 ? u.cacheRead : 0;
  const fresh = typeof u.input === "number" && u.input > 0 ? u.input : 0;
  if (cached === 0 && fresh === 0) return null;
  return { cached, fresh };
}

function ratio(cached: number, fresh: number): number | null {
  const total = cached + fresh;
  return total > 0 ? cached / total : null;
}

/** Aggregate prompt-cache stats for one thread, from its message usage. */
export function cacheStatsOf(messages: ViewMessage[]): CacheStats {
  let cached = 0;
  let fresh = 0;
  let hitCount = 0;
  let requestCount = 0;
  let costTotal = 0;
  const recent: { cached: number; fresh: number }[] = [];
  for (const m of messages) {
    const t = requestTokens(m);
    if (t) {
      cached += t.cached;
      fresh += t.fresh;
      requestCount += 1;
      if (t.cached > 0) hitCount += 1;
      recent.push(t);
      if (recent.length > RECENT_WINDOW) recent.shift();
    }
    const turnCost = m.usage?.cost?.total;
    if (typeof turnCost === "number" && Number.isFinite(turnCost)) costTotal += turnCost;
  }
  const recentCached = recent.reduce((s, t) => s + t.cached, 0);
  const recentFresh = recent.reduce((s, t) => s + t.fresh, 0);
  return {
    hitRatio: requestCount ? ratio(cached, fresh) : null,
    recentRatio: recent.length ? ratio(recentCached, recentFresh) : null,
    hitCount,
    requestCount,
    cachedTokens: cached,
    totalInput: cached + fresh,
    costTotal,
  };
}

/** "99.6" -> "100%", "0.12" -> "12%" — nearest whole percent, dash when empty. */
export function percentText(r: number | null): string {
  if (r === null) return "—";
  return `${Math.round(r * 100)}%`;
}
