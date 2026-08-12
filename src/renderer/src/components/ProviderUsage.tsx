import { Refresh } from "./icons";
import { useStore } from "../store";
import { formatTokens } from "../lib/format";
import { percentText, type CacheStats } from "../lib/cache";
import type { ProviderUsageLimit, ProviderUsageReport } from "../lib/types";

/** Human text for one quota amount, by unit (percent / usd / balance / raw counts). */
function amountText(l: ProviderUsageLimit): string {
  const a = l.amount;
  if (a.unit === "percent") return `${Math.round(a.used ?? 0)}%`;
  if (a.unit === "usd") return `$${Number(a.used ?? 0).toFixed(2)} / $${Number(a.limit ?? 0).toFixed(2)}`;
  if (a.unit === "balance") {
    const c = a.currency || "";
    const symbol = c === "CNY" || c === "CNH" ? "¥" : c === "USD" ? "$" : c ? `${c} ` : "";
    return `${symbol}${Number(a.used ?? 0).toFixed(2)}`;
  }
  return `${a.used ?? 0} / ${a.limit ?? "?"}`;
}

/**
 * Validate the `app:getProviderUsage` IPC envelope + payload into the typed
 * report list. Everything from the CLI is untrusted: the guard checks the
 * outer `{ok, data}` shape and that `reports` is an array of objects with a
 * string `provider`; the nested limit fields are consumed defensively below.
 */
export function parseProviderUsage(data: unknown): ProviderUsageReport[] | null {
  if (!data || typeof data !== "object" || !("ok" in data) || data.ok !== true || !("data" in data)) return null;
  const payload = data.data;
  if (!payload || typeof payload !== "object" || !("reports" in payload) || !Array.isArray(payload.reports)) return null;
  const out: ProviderUsageReport[] = [];
  for (const r of payload.reports) {
    if (r && typeof r === "object" && "provider" in r && typeof r.provider === "string") {
      out.push(r as ProviderUsageReport);
    }
  }
  return out;
}

/**
 * One-line provider plan/balance strip pinned above the composer. Shows the
 * current thread's provider when its usage report is available.
 */
export function ProviderUsageInline({ report, refreshing, onRefresh }: { report: ProviderUsageReport; refreshing: boolean; onRefresh: () => void }) {
  const zh = useStore((s) => s.config?.language !== "en");
  const heading = report.metadata?.planType || report.provider;
  return (
    <span className="puv-group">
      <span className="puv-name">{zh ? `${heading} 套餐用量` : `${heading} quota`}</span>
      {report.limits.map((l) => {
        const isBalance = l.amount.unit === "balance";
        const exhausted = l.status === "exhausted";
        const fraction = l.amount.usedFraction;
        const near = l.status === "warning" || (!exhausted && !isBalance && typeof fraction === "number" && fraction >= 0.85);
        const label = zh ? l.label : l.label === "账户余额" ? "Account balance" : l.label;
        const detail = [
          l.window.label && `${l.window.label}`,
          l.window.resetsAt &&
            `${zh ? "重置：" : "Resets: "}${new Date(l.window.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
          exhausted && (zh ? "已用尽" : "Exhausted"),
          near && (zh ? "接近上限" : "Near limit"),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <span key={l.id} className={`puv-chip${exhausted ? " exhausted" : near ? " near" : ""}`} title={detail || l.label}>
            <span className="puv-chip-label">{label}</span>
            <span className="puv-chip-value">{amountText(l)}</span>
            {exhausted && <em>{zh ? "已用尽" : "Exhausted"}</em>}
          </span>
        );
      })}
      <button className="puv-refresh" title={refreshing ? (zh ? "刷新中…" : "Refreshing…") : zh ? "刷新用量" : "Refresh usage"} disabled={refreshing} onClick={onRefresh}>
        {refreshing ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> : <Refresh size={11} />}
      </button>
    </span>
  );
}

/**
 * Prompt-cache statistics for the current thread, computed in the renderer
 * from message usage (no extension / plugin involved). Sits in the same
 * bottom strip as the provider quota.
 */
export function CacheUsageInline({ stats }: { stats: CacheStats }) {
  const zh = useStore((s) => s.config?.language !== "en");
  if (stats.requestCount === 0) return null;
  return (
    <span className="puv-group">
      <span className="puv-chip">
        <span className="puv-chip-label">{zh ? "缓存命中率" : "Cache hit"}</span>
        <span className="puv-chip-value">{percentText(stats.hitRatio)}</span>
      </span>
      <span className="puv-chip">
        <span className="puv-chip-label">{zh ? `最近${Math.min(stats.requestCount, 10)}次` : `Last ${Math.min(stats.requestCount, 10)}`}</span>
        <span className="puv-chip-value">{percentText(stats.recentRatio)}</span>
      </span>
      <span className="puv-chip">
        <span className="puv-chip-label">{zh ? "命中" : "Hits"}</span>
        <span className="puv-chip-value">
          {stats.hitCount}/{stats.requestCount}
          {zh ? " 次" : ""}
        </span>
      </span>
      <span className="puv-chip">
        <span className="puv-chip-label">{zh ? "缓存" : "Cache"}</span>
        <span className="puv-chip-value">
          {formatTokens(stats.cachedTokens)}/{formatTokens(stats.totalInput)}
        </span>
      </span>
    </span>
  );
}
