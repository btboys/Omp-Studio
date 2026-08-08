import { useMemo, useState } from "react";
import { useStore } from "../store";
import { Close, Plus, At, Refresh, Search } from "./icons";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

const KIND_LABEL: Record<string, string> = { npm: "npm", git: "git", local: "本地" };

export function PluginsPanel() {
  const open = useStore((s) => s.pluginsOpen);
  const close = useStore((s) => s.closePlugins);
  const packages = useStore((s) => s.packages);
  const skills = useStore((s) => s.skills);
  const loading = useStore((s) => s.pluginsLoading);
  const togglePackage = useStore((s) => s.togglePackage);
  const installPackage = useStore((s) => s.installPackage);
  const removePackage = useStore((s) => s.removePackage);
  const updatePackages = useStore((s) => s.updatePackages);
  const loadPlugins = useStore((s) => s.loadPlugins);
  const toggleSkill = useStore((s) => s.toggleSkill);
  const language = useStore((s) => s.config?.language || "en");

  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updatingOne, setUpdatingOne] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const filteredPackages = useMemo(
    () =>
      packages.filter((p) =>
        !normalizedQuery || [p.name, p.source, p.kind].some((value) => value.toLowerCase().includes(normalizedQuery)),
      ),
    [packages, normalizedQuery],
  );
  const filteredSkills = useMemo(
    () =>
      skills.filter((sk) =>
        !normalizedQuery || [sk.name, sk.path, sk.root].some((value) => value.toLowerCase().includes(normalizedQuery)),
      ),
    [skills, normalizedQuery],
  );

  if (!open) return null;

  const install = async () => {
    const s = source.trim();
    if (!s) return;
    setBusy(true);
    await installPackage(s);
    setBusy(false);
    setSource("");
  };

  const updating = updatingAll || updatingOne !== null;
  const updateAll = async () => {
    if (updating) return;
    setUpdatingAll(true);
    await updatePackages();
    setUpdatingAll(false);
  };
  const updateOne = async (src: string) => {
    if (updating) return;
    setUpdatingOne(src);
    await updatePackages(src);
    setUpdatingOne(null);
  };

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="plugins-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="plugins-head">
          <div className="plugins-head-title">
            <span className="set-brand-mark">
              <At size={18} />
            </span>
            <div>
              <div className="set-brand-title">插件</div>
              <div className="set-brand-sub">管理 omp 的扩展与 skill</div>
            </div>
          </div>
          <button className="set-iconbtn" title="关闭" onClick={close}>
            <Close size={16} />
          </button>
        </header>

        <div className="plugins-body">
          <div className="muted plugins-note">
            扩展扫描 ~/.omp/agent/extensions（停用即重命名为 *.disabled）；skill 扫描 ~/.omp/agent/skills 与项目 .omp/.pi skills 目录，停用通过 SKILL.md 的 enabled: false 标记实现。
          </div>

          <div className="plugins-toolbar">
            <div className="plugins-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索插件或 skill"
                aria-label="搜索插件或 skill"
              />
              {query && (
                <button type="button" className="plugins-search-clear" onClick={() => setQuery("")} aria-label="清除搜索">
                  ×
                </button>
              )}
            </div>
            <button className="set-iconbtn" onClick={() => loadPlugins()} disabled={loading} title="刷新插件和 skill">
              {loading ? <span className="spinner" /> : <Refresh size={15} />}
            </button>
          </div>

          <section className="plugins-section">
            <div className="plugins-section-head plugins-section-head-row">
              <span>
                Extension 包（{filteredPackages.length}
                {normalizedQuery ? ` / ${packages.length}` : ""}）
              </span>
              <button className="set-btn" onClick={updateAll} disabled={updating || packages.length === 0} title="检查并更新所有扩展（omp plugin upgrade）">
                {updatingAll ? <span className="spinner" /> : <Refresh size={13} />}
                更新全部
              </button>
            </div>

            <div className="plugins-install">
              <input
                className="set-input"
                placeholder="安装来源，如 npm:@foo/bar 或 git:github.com/user/repo 或本地路径"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && install()}
              />
              <button className="set-btn primary" onClick={install} disabled={busy || !source.trim()}>
                {busy ? <span className="spinner" /> : <Plus size={14} />} 安装
              </button>
            </div>

            {loading && packages.length === 0 && <div className="set-empty-mini">加载中…</div>}
            {!loading && packages.length === 0 && <div className="set-empty-mini">尚未安装任何 extension 包。</div>}
            {packages.length > 0 && filteredPackages.length === 0 && <div className="set-empty-mini">没有匹配的 extension 包。</div>}
            {filteredPackages.map((p) => (
              <div className="plugins-row" key={p.source}>
                <div className="plugins-row-main">
                  <span className="plugins-row-name" title={p.source}>
                    {p.name}
                  </span>
                  <span className="plugins-kind">{KIND_LABEL[p.kind] || p.kind}</span>
                  {!p.enabled && <span className="plugins-off">已停用</span>}
                </div>
                <div className="plugins-row-sub" title={p.source}>
                  {p.source}
                </div>
                <div className="plugins-row-actions">
                  <button
                    className="set-iconbtn"
                    title="检查并更新此扩展"
                    disabled={updating}
                    onClick={() => updateOne(p.source)}
                  >
                    {updatingOne === p.source ? <span className="spinner" /> : <Refresh size={13} />}
                  </button>
                  <Toggle checked={p.enabled} onChange={(v) => togglePackage(p.source, v)} />
                  <button
                    className="set-iconbtn danger"
                    title="移除"
                    onClick={() => {
                      const question = language === "zh" ? `移除包 “${p.name}”？` : `Remove package “${p.name}”?`;
                      if (window.confirm(question)) removePackage(p.source);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="plugins-section">
            <div className="plugins-section-head">
              Skills（{filteredSkills.length}
              {normalizedQuery ? ` / ${skills.length}` : ""}）
            </div>
            {loading && skills.length === 0 && <div className="set-empty-mini">加载中…</div>}
            {!loading && skills.length === 0 && <div className="set-empty-mini">未在 ~/.omp/agent/skills 等目录发现独立 skill。</div>}
            {skills.length > 0 && filteredSkills.length === 0 && <div className="set-empty-mini">没有匹配的 skill。</div>}
            {filteredSkills.map((sk) => (
              <div className="plugins-row" key={sk.path}>
                <div className="plugins-row-main">
                  <span className="plugins-row-name" title={sk.path}>
                    {sk.name}
                  </span>
                  {!sk.enabled && <span className="plugins-off">已停用</span>}
                </div>
                <div className="plugins-row-sub" title={sk.path}>
                  {sk.path}
                </div>
                <div className="plugins-row-actions">
                  <Toggle checked={sk.enabled} onChange={(v) => toggleSkill(sk.path, v)} />
                </div>
              </div>
            ))}
            <div className="muted plugins-note">停用 skill 会将其入口文件重命名为 *.disabled（可逆）；新增文件后可点击右上角刷新。</div>
          </section>
        </div>
      </div>
    </div>
  );
}
