import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { ModelInfo } from "../lib/types";

/**
 * Login / logout for omp's built-in (OAuth / API-key) providers, backed by
 * `omp auth-broker login|logout <provider>`. Login state is derived from the
 * live provider registry (a provider has credentials iff omp lists it).
 */

export interface AuthProviderInfo {
  id: string;
  name: string;
}

interface Props {
  language: "zh" | "en";
  liveProviders: Record<string, { baseUrl?: string; api?: string; models: ModelInfo[] }>;
  /** Called after a successful login/logout so the parent refreshes registry + open threads. */
  onAuthChanged: () => void;
}

interface ListAuthProvidersResult {
  ok: boolean;
  providers?: AuthProviderInfo[];
  error?: string;
}
interface AuthStartResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}
interface AuthLogoutResult {
  ok: boolean;
  output?: string;
}
interface AuthEvent {
  sessionId: string;
  type: "line" | "awaiting-input" | "done";
  text?: string;
  ok?: boolean;
  message?: string;
}

interface LoginState {
  providerId: string;
  name: string;
  log: string[];
  awaitingInput: boolean;
  input: string;
}

export function ProviderAuthPanel({ language, liveProviders, onAuthChanged }: Props) {
  const pushToast = useStore((s) => s.pushToast);
  const [providers, setProviders] = useState<AuthProviderInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const t = (zh: string, en: string) => (language === "zh" ? zh : en);

  useEffect(() => {
    let alive = true;
    window.pi.settings
      .listAuthProviders()
      .then((res) => {
        if (!alive) return;
        if (res?.ok) setProviders((res as ListAuthProvidersResult).providers || []);
        else setLoadError((res as ListAuthProvidersResult).error || "Failed to load providers");
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Stream the active login session's output from main.
  useEffect(() => {
    if (!login) return;
    return window.pi.on.auth((p) => {
      const ev = p as AuthEvent;
      if (!ev || ev.sessionId !== login.providerId) return;
      if (ev.type === "line") {
        setLogin((l) => (l && l.providerId === ev.sessionId ? { ...l, log: [...l.log, ev.text || ""] } : l));
      } else if (ev.type === "awaiting-input") {
        setLogin((l) => (l && l.providerId === ev.sessionId ? { ...l, awaitingInput: true } : l));
      } else if (ev.type === "done") {
        const ok = Boolean(ev.ok);
        const message = ev.message || (ok ? t("登录成功", "Signed in") : t("登录失败", "Sign-in failed"));
        setLogin(null);
        if (ok) {
          pushToast("success", message);
          onAuthChanged();
        } else {
          pushToast("error", message);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.providerId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [login?.log]);

  const startLogin = async (p: AuthProviderInfo) => {
    if (login) return;
    setLogin({ providerId: p.id, name: p.name, log: [], awaitingInput: false, input: "" });
    try {
      const res = (await window.pi.settings.authLoginStart(p.id)) as AuthStartResult;
      if (!res?.ok) {
        setLogin(null);
        pushToast("error", res?.error || t("无法启动登录流程", "Could not start sign-in"));
      }
    } catch (e: unknown) {
      setLogin(null);
      pushToast("error", e instanceof Error ? e.message : String(e));
    }
  };

  const submitInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (!login || !login.input.trim()) return;
    window.pi.settings.authLoginInput(login.providerId, login.input.trim());
    setLogin((l) => (l ? { ...l, input: "" } : l));
  };

  const cancelLogin = () => {
    if (!login) return;
    window.pi.settings.authLoginCancel(login.providerId);
    setLogin(null);
  };

  const logout = async (p: AuthProviderInfo) => {
    if (busy) return;
    const question = t(`登出 ${p.name}？其 omp 登录凭证将被删除。`, `Sign out of ${p.name}? Its omp credentials will be removed.`);
    if (!window.confirm(question)) return;
    setBusy(p.id);
    try {
      const res = (await window.pi.settings.authLogout(p.id)) as AuthLogoutResult;
      if (res?.ok) {
        pushToast("success", res.output || t("已登出", "Signed out"));
        onAuthChanged();
      } else {
        pushToast("error", res?.output || t("登出失败", "Sign-out failed"));
      }
    } catch (e: unknown) {
      pushToast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(() => {
    if (!providers) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [providers, filter]);

  return (
    <div className="set-card">
      <div className="set-card-title">{t("内置供应商登录", "Built-in provider sign-in")}</div>
      <div className="set-hint">
        {t(
          "使用 omp auth-broker 登录内置订阅/API 供应商（Cursor、Claude、Codex、Kimi Code 等）。登录会在浏览器中完成授权，凭证存入 omp agent 数据库；登录后的供应商出现在上方「已启用的提供商」。",
          "Sign in to omp's built-in subscription/API providers (Cursor, Claude, Codex, Kimi Code, …) via the auth-broker. Authorization happens in your browser; credentials are stored in omp's agent database, and signed-in providers appear under Active providers above.",
        )}
      </div>
      <input
        className="set-input auth-prov-filter"
        placeholder={t("筛选供应商…", "Filter providers…")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="auth-prov-list">
        {providers === null && !loadError && (
          <div className="set-empty-mini">{t("正在加载…", "Loading…")}</div>
        )}
        {loadError && <div className="set-empty-mini">{loadError}</div>}
        {visible.map((p) => {
          const active = Boolean(liveProviders[p.id]);
          return (
            <div className="auth-prov-row" key={p.id}>
              <div className="auth-prov-info">
                <span className="auth-prov-name">{p.name}</span>
                <span className="auth-prov-id muted">{p.id}</span>
                <span className={`auth-prov-status ${active ? "on" : ""}`}>
                  {active ? t("已登录", "Signed in") : t("未登录", "Not signed in")}
                </span>
              </div>
              {active ? (
                <button className="set-btn danger" onClick={() => logout(p)} disabled={busy === p.id}>
                  {busy === p.id ? <span className="spinner" /> : t("登出", "Sign out")}
                </button>
              ) : (
                <button className="set-btn" onClick={() => startLogin(p)} disabled={!!login}>
                  {t("登录", "Sign in")}
                </button>
              )}
            </div>
          );
        })}
        {providers !== null && visible.length === 0 && <div className="set-empty-mini">{t("无匹配供应商", "No matching providers")}</div>}
      </div>

      {login && (
        <div className="modal-backdrop" onMouseDown={cancelLogin}>
          <div className="modal auth-login-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {t("登录", "Sign in to")} {login.name}
            </div>
            <div className="auth-login-log" ref={logRef}>
              {login.log.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              {!login.awaitingInput && login.log.length > 0 && (
                <div className="auth-login-wait">{t("请在浏览器中完成授权…", "Waiting for authorization in your browser…")}</div>
              )}
            </div>
            {login.awaitingInput && (
              <form onSubmit={submitInput}>
                <input
                  className="modal-input"
                  autoFocus
                  value={login.input}
                  placeholder={t("粘贴授权码或 API 密钥后回车", "Paste the authorization code or API key and press Enter")}
                  onChange={(e) => setLogin((l) => (l ? { ...l, input: e.target.value } : l))}
                />
              </form>
            )}
            <div className="modal-actions">
              <button className="set-btn ghost" onClick={cancelLogin}>
                {t("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
