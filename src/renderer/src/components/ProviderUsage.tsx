import { Refresh } from "./icons";
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
export function ProviderUsageInline({ report, onRefresh }: { report: ProviderUsageReport; onRefresh: () => void }) {
  const heading = report.metadata?.planType || report.provider;
  return (
    <div className="provider-usage-inline">
      <span className="puv-name">{heading}</span>
      {report.limits.map((l) => {
        const isBalance = l.amount.unit === "balance";
        const exhausted = l.status === "exhausted";
        const fraction = l.amount.usedFraction;
        const near = l.status === "warning" || (!exhausted && !isBalance && typeof fraction === "number" && fraction >= 0.85);
        const detail = [
          l.window.label && `${l.window.label}`,
          l.window.resetsAt && `重置：${new Date(l.window.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
          exhausted && "已用尽",
          near && "接近上限",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <span key={l.id} className={`puv-chip${exhausted ? " exhausted" : near ? " near" : ""}`} title={detail || l.label}>
            <span className="puv-chip-label">{l.label}</span>
            <span className="puv-chip-value">{amountText(l)}</span>
            {exhausted && <em>已用尽</em>}
          </span>
        );
      })}
      <button className="puv-refresh" title="刷新用量" onClick={onRefresh}>
        <Refresh size={11} />
      </button>
    </div>
  );
}
