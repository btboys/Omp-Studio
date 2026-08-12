import { useState } from "react";
import { ChevronDown, ChevronUp, Refresh } from "./icons";
import { useStore } from "../store";
import { formatTokens } from "../lib/format";
import { translateUiText } from "../lib/i18n";
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
  const language = useStore((s) => s.config?.language || "en");
  const [expanded, setExpanded] = useState(false);
  const heading = report.metadata?.planType || report.provider;
  const manyLimits = report.limits.length > 1;
  const primary = report.limits.find((l) => l.amount.unit === "balance") || report.limits[0];
  const limitLabel = (raw: string) => (zh ? (raw === "账户余额" ? "余额" : raw) : translateUiText(raw, language));
  return (
    <span className="puv-group">
      <button
        className="puv-toggle"
        onClick={() => manyLimits && setExpanded((v) => !v)}
        title={
          manyLimits
            ? expanded
              ? translateUiText("收起用量明细", language)
              : translateUiText("展开用量明细", language)
            : undefined
        }
        aria-expanded={expanded}
      >
        <span className="puv-name">{heading}</span>
        {manyLimits && (expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
      {expanded || !manyLimits
        ? report.limits.map((l) => {
            const isBalance = l.amount.unit === "balance";
            const exhausted = l.status === "exhausted";
            const fraction = l.amount.usedFraction;
            const near = l.status === "warning" || (!exhausted && !isBalance && typeof fraction === "number" && fraction >= 0.85);
            const label = limitLabel(l.label);
            const detail = [
              l.window.label && `${l.window.label}`,
              l.window.resetsAt &&
                `${translateUiText("重置：", language)}${new Date(l.window.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
              exhausted && translateUiText("已用尽", language),
              near && translateUiText("接近上限", language),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <span key={l.id} className={`puv-chip${exhausted ? " exhausted" : near ? " near" : ""}`} title={detail || l.label}>
                <span className="puv-chip-label">{label}</span>
                <span className="puv-chip-value">{amountText(l)}</span>
                {exhausted && <em>{translateUiText("已用尽", language)}</em>}
              </span>
            );
          })
        : primary && (
            <span className="puv-chip" title={primary.window?.label || primary.label}>
              <span className="puv-chip-label">{limitLabel(primary.label)}</span>
              <span className="puv-chip-value">{amountText(primary)}</span>
            </span>
          )}
      <button className="puv-refresh" title={refreshing ? translateUiText("刷新中…", language) : translateUiText("刷新用量", language)} disabled={refreshing} onClick={onRefresh}>
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
export function CacheUsageInline({ stats, currency }: { stats: CacheStats; currency?: string }) {
  const language = useStore((s) => s.config?.language || "en");
  const zh = language !== "en";
  if (stats.requestCount === 0) return null;
  // Locale-aware monetary formatting: symbol/code comes from the provider's
  // reported currency (never hardcoded), and decimals follow the active locale.
  const costText =
    currency && stats.costTotal > 0
      ? new Intl.NumberFormat(language, { style: "currency", currency, minimumFractionDigits: 4 }).format(stats.costTotal)
      : stats.costTotal > 0
        ? new Intl.NumberFormat(language, { minimumFractionDigits: 4 }).format(stats.costTotal)
        : "";
  return (
    <span className="puv-group">
      <span className="puv-chip">
        <span className="puv-chip-label">{translateUiText("缓存命中率", language)}</span>
        <span className="puv-chip-value">{percentText(stats.hitRatio)}</span>
      </span>
      <span className="puv-chip">
        <span className="puv-chip-label">
          {zh ? `最近${Math.min(stats.requestCount, 10)}次` : `Last ${Math.min(stats.requestCount, 10)}`}
        </span>
        <span className="puv-chip-value">{percentText(stats.recentRatio)}</span>
      </span>
      <span className="puv-chip">
        <span className="puv-chip-label">{translateUiText("命中", language)}</span>
        <span className="puv-chip-value">
          {stats.hitCount}/{stats.requestCount}
          {zh ? " 次" : ""}
        </span>
      </span>
      <span className="puv-chip">
        <span className="puv-chip-label">{translateUiText("缓存", language)}</span>
        <span className="puv-chip-value">
          {formatTokens(stats.cachedTokens)}/{formatTokens(stats.totalInput)}
        </span>
      </span>
      {stats.costTotal > 0 && costText && (
        <span className="puv-chip">
          <span className="puv-chip-label">{translateUiText("金额", language)}</span>
          <span className="puv-chip-value">{costText}</span>
        </span>
      )}
    </span>
  );
}
