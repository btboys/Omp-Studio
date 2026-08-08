import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { McpServerConfig, McpServerInfo, McpSource } from "../lib/types";
import { Close, Plus, Plug, Refresh, Search, Edit } from "./icons";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

const TYPE_LABEL: Record<string, string> = { stdio: "stdio", http: "http", sse: "sse" };

const SOURCE_LABEL: Record<McpSource, string> = {
  omp: "OMP",
  claude: "Claude Code",
  codex: "OpenAI Codex",
};

interface Draft {
  name: string;
  type: "stdio" | "http" | "sse";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  enabled: boolean;
}

const emptyDraft = (): Draft => ({
  name: "",
  type: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
  enabled: true,
});

function kvToText(kv: Record<string, string> | undefined): string {
  return Object.entries(kv || {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

function draftFromServer(name: string, config: McpServerConfig): Draft {
  const type = config.type === "http" || config.type === "sse" ? config.type : "stdio";
  return {
    name,
    type,
    command: config.command || "",
    args: (config.args || []).join("\n"),
    env: kvToText(config.env),
    cwd: config.cwd || "",
    url: config.url || "",
    headers: kvToText(config.headers),
    enabled: config.enabled !== false,
  };
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf("=");
    if (idx <= 0) continue;
    const key = t.slice(0, idx).trim();
    const value = t.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Rebuild the saved config from the editor draft. `enabled` is always sent
 * (so re-enabling a disabled server persists), and empty transport fields are
 * sent as empty values — the main process prunes them, which is what actually
 * clears a previously set env/headers/cwd.
 */
function configFromDraft(d: Draft): McpServerConfig {
  const config: McpServerConfig = { type: d.type, enabled: d.enabled };
  if (d.type === "stdio") {
    config.command = d.command.trim();
    config.args = d.args.split("\n").map((s) => s.trim()).filter(Boolean);
    config.env = parseKv(d.env);
    config.cwd = d.cwd.trim();
  } else {
    config.url = d.url.trim();
    config.headers = parseKv(d.headers);
  }
  return config;
}

/** Status dot: ● connected / ○ not connected / ◌ disabled. */
function StatusDot({ status }: { status: McpServerInfo["status"] }) {
  return (
    <span
      className={`mcp-status mcp-status-${status}`}
      title={
        status === "connected" ? "已连接" : status === "disabled" ? "已禁用" : "未连接"
      }
      aria-label={status}
    />
  );
}

export function McpPanel() {
  const open = useStore((s) => s.mcpOpen);
  const close = useStore((s) => s.closeMcp);
  const mcpState = useStore((s) => s.mcpState);
  const loading = useStore((s) => s.mcpLoading);
  const loadMcp = useStore((s) => s.loadMcp);
  const saveMcpServer = useStore((s) => s.saveMcpServer);
  const removeMcpServer = useStore((s) => s.removeMcpServer);
  const setMcpServerEnabled = useStore((s) => s.setMcpServerEnabled);
  const pushToast = useStore((s) => s.pushToast);
  const language = useStore((s) => s.config?.language || "en");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const servers = mcpState?.servers || [];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      servers.filter((s) =>
        !normalizedQuery || [s.name, s.endpoint, s.type, s.source].some((v) => v.toLowerCase().includes(normalizedQuery)),
      ),
    [servers, normalizedQuery],
  );
  const grouped = useMemo(() => {
    const order: McpSource[] = ["claude", "omp", "codex"];
    return order
      .map((source) => ({ source, servers: filtered.filter((s) => s.source === source) }))
      .filter((g) => g.servers.length > 0);
  }, [filtered]);

  if (!open) return null;

  const startEdit = (name: string, config: McpServerConfig) => {
    setEditingName(name);
    setDraft(draftFromServer(name, config));
  };
  const openNew = () => {
    setEditingName(null);
    setDraft(emptyDraft());
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      pushToast("warning", "服务器名称不能为空。");
      return;
    }
    const type = draft.type;
    const endpoint = type === "stdio" ? draft.command.trim() : draft.url.trim();
    if (!endpoint) {
      pushToast("warning", type === "stdio" ? "需要填写命令（command）。" : "需要填写 URL。");
      return;
    }
    setBusy(true);
    try {
      await saveMcpServer(draft.name.trim(), configFromDraft(draft));
      setDraft(null);
    } catch {
      // store already toasted; keep the draft so input is not lost
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="plugins-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="plugins-head">
          <div className="plugins-head-title">
            <span className="set-brand-mark">
              <Plug size={18} />
            </span>
            <div>
              <div className="set-brand-title">MCP 服务器</div>
              <div className="set-brand-sub">聚合 omp / Claude Code / Codex 的 MCP 配置并检测连接</div>
            </div>
          </div>
          <button className="set-iconbtn" title="关闭" onClick={close}>
            <Close size={16} />
          </button>
        </header>

        <div className="plugins-body">
          <div className="muted plugins-note">
            OMP 配置写入 {mcpState?.path || "~/.omp/agent/mcp.json"}；Claude Code 与 Codex 来源只读显示，启用/禁用通过 OMP 的禁用/启用列表控制。
            {mcpState?.path && (
              <button className="mcp-open-path" onClick={() => void window.pi.settings.openPath(mcpState.path)} title="在系统默认应用中打开">
                打开文件
              </button>
            )}
          </div>

          <div className="plugins-toolbar">
            <div className="plugins-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索服务器"
                aria-label="搜索服务器"
              />
              {query && (
                <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label="清除搜索">
                  ×
                </button>
              )}
            </div>
            <button className="set-iconbtn" onClick={() => loadMcp()} disabled={loading} title="刷新并重新检测连接">
              {loading ? <span className="spinner" /> : <Refresh size={15} />}
            </button>
            <button className="set-btn primary" onClick={openNew} disabled={!!draft}>
              <Plus size={14} /> 新增
            </button>
          </div>

          {draft && (
            <div className="mcp-editor">
              <div className="mcp-editor-title">{draft.name ? `编辑 ${draft.name}` : "新增服务器"}</div>
              <div className="mcp-editor-grid">
                <label className="mcp-field">
                  <span>名称</span>
                  <input
                    className="set-input"
                    value={draft.name}
                    disabled={!!editingName}
                    title={editingName ? "编辑模式下不可改名；如需改名请删除后重建" : undefined}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="如 my-server"
                  />
                </label>
                <label className="mcp-field">
                  <span>类型</span>
                  <select
                    className="set-select"
                    value={draft.type}
                    onChange={(e) => patch({ type: e.target.value as Draft["type"] })}
                  >
                    <option value="stdio">stdio（本地命令）</option>
                    <option value="http">http（远程端点）</option>
                    <option value="sse">sse（旧版远程端点）</option>
                  </select>
                </label>
                {draft.type === "stdio" ? (
                  <>
                    <label className="mcp-field mcp-field-wide">
                      <span>命令 command</span>
                      <input
                        className="set-input"
                        value={draft.command}
                        onChange={(e) => patch({ command: e.target.value })}
                        placeholder="如 npx -y @modelcontextprotocol/server-filesystem"
                      />
                    </label>
                    <label className="mcp-field mcp-field-wide">
                      <span>参数 args（每行一个）</span>
                      <textarea
                        className="set-input mcp-textarea"
                        value={draft.args}
                        onChange={(e) => patch({ args: e.target.value })}
                        placeholder={"/path/to/dir\n--flag"}
                        rows={3}
                      />
                    </label>
                    <label className="mcp-field mcp-field-wide">
                      <span>环境变量 env（每行 KEY=VALUE）</span>
                      <textarea
                        className="set-input mcp-textarea"
                        value={draft.env}
                        onChange={(e) => patch({ env: e.target.value })}
                        placeholder={"API_KEY=xxx\nDEBUG=1"}
                        rows={3}
                      />
                    </label>
                    <label className="mcp-field mcp-field-wide">
                      <span>工作目录 cwd</span>
                      <input
                        className="set-input"
                        value={draft.cwd}
                        onChange={(e) => patch({ cwd: e.target.value })}
                        placeholder="默认：omp 启动目录"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="mcp-field mcp-field-wide">
                      <span>URL</span>
                      <input
                        className="set-input"
                        value={draft.url}
                        onChange={(e) => patch({ url: e.target.value })}
                        placeholder="https://example.com/mcp"
                      />
                    </label>
                    <label className="mcp-field mcp-field-wide">
                      <span>请求头 headers（每行 KEY=VALUE）</span>
                      <textarea
                        className="set-input mcp-textarea"
                        value={draft.headers}
                        onChange={(e) => patch({ headers: e.target.value })}
                        placeholder={"Authorization=Bearer xxx"}
                        rows={3}
                      />
                    </label>
                  </>
                )}
                <div className="mcp-field mcp-field-wide mcp-enable-row">
                  <span>启用</span>
                  <Toggle checked={draft.enabled} onChange={(v) => patch({ enabled: v })} />
                </div>
              </div>
              <div className="mcp-editor-actions">
                <button className="set-btn primary" onClick={() => void save()} disabled={busy}>
                  {busy ? <span className="spinner" /> : null} 保存
                </button>
                <button className="set-btn ghost" onClick={() => setDraft(null)} disabled={busy}>
                  取消
                </button>
              </div>
            </div>
          )}

          {loading && servers.length === 0 && <div className="set-empty-mini">加载中…</div>}
          {!loading && servers.length === 0 && <div className="set-empty-mini">未发现任何 MCP 服务器，点击右上角“新增”。</div>}
          {servers.length > 0 && filtered.length === 0 && <div className="set-empty-mini">没有匹配的服务器。</div>}

          {grouped.map((group) => (
            <section className="plugins-section" key={group.source}>
              <div className="plugins-section-head plugins-section-head-row">
                <span>
                  {SOURCE_LABEL[group.source]}（{group.servers.length}）
                </span>
                {group.source === "omp" && (
                  <button className="set-btn ghost" onClick={openNew} disabled={!!draft}>
                    <Plus size={13} /> 新增
                  </button>
                )}
              </div>
              {group.servers.map((s) => (
                <McpRow
                  key={s.name}
                  server={s}
                  language={language}
                  onEdit={() => startEdit(s.name, s.config)}
                  onToggle={(v) => setMcpServerEnabled(s.name, v)}
                  onRemove={() => {
                    const question =
                      language === "zh"
                        ? s.discovered
                          ? `将 “${s.name}” 从禁用/启用列表中移除？`
                          : `删除服务器 “${s.name}”？`
                        : s.discovered
                          ? `Remove “${s.name}” from the disabled/enabled lists?`
                          : `Remove server “${s.name}”?`;
                    if (window.confirm(question)) removeMcpServer(s.name);
                  }}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function McpRow({
  server,
  language,
  onEdit,
  onToggle,
  onRemove,
}: {
  server: McpServerInfo;
  language: string;
  onEdit: () => void;
  onToggle: (v: boolean) => void;
  onRemove: () => void;
}) {
  const s = server;
  const editable = s.source === "omp" && !s.discovered;
  return (
    <div className="plugins-row" key={s.name}>
      <div className="plugins-row-main">
        <StatusDot status={s.status} />
        <span className="plugins-row-name" title={s.name}>
          {s.name}
        </span>
        {s.type !== "other" && <span className="plugins-kind">{TYPE_LABEL[s.type] || s.type}</span>}
        {s.source !== "omp" && <span className="plugins-kind mcp-kind-source">{SOURCE_LABEL[s.source]}</span>}
        {s.discovered && <span className="plugins-kind">其他来源</span>}
        {!s.enabled && <span className="plugins-off">已停用</span>}
      </div>
      <div className="plugins-row-sub" title={s.endpoint || s.source}>
        {s.discovered ? "来自禁用/启用列表（来源未知）" : s.endpoint || "(无端点)"}
      </div>
      <div className="plugins-row-actions">
        {editable && (
          <button className="set-iconbtn" title="编辑" onClick={onEdit}>
            <Edit size={13} />
          </button>
        )}
        <Toggle checked={s.enabled} onChange={onToggle} />
        {editable && (
          <button className="set-iconbtn danger" title="删除" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}
