import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useOutsideClose } from "../lib/useOutsideClose";
import { fileIcon } from "../lib/format";
import type { GitCommitDetail, GitCommitFile, GitLogEntry, GitLogOpts, GitOpResult, GitStatusResult } from "../lib/types";
import { Branch, Check, ChevronRight, Minus, Plus, Refresh, Sparkle, Undo } from "./icons";

/** Changed-file tree of one commit: expandable directories, status-letter leaves. */
function CommitFileTree({ files, onFileClick }: { files: GitCommitFile[]; onFileClick: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  type Node = { dirs: Map<string, Node>; files: GitCommitFile[] };
  const rootNode = useMemo<Node>(() => {
    const root: Node = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const d = parts[i];
        if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
        node = node.dirs.get(d)!;
      }
      node.files.push(f);
    }
    return root;
  }, [files]);
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const render = (node: Node, prefix: string, depth: number): React.ReactNode => (
    <>
      {[...node.dirs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, child]) => {
          const key = `${prefix}${name}/`;
          const open = !collapsed.has(key);
          return (
            <div key={key}>
              <div className="gpd-dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(key)}>
                <ChevronRight size={10} className={open ? "gpd-caret-open" : ""} />
                <span className="gpd-dir-name">{name}</span>
                <span className="gpd-dir-count">{child.files.length + child.dirs.size}</span>
              </div>
              {open && render(child, key, depth + 1)}
            </div>
          );
        })}
      {[...node.files]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => (
          <div
            className="gpd-file"
            key={f.path}
            style={{ paddingLeft: 10 + depth * 14 + 16 }}
            title={f.path}
            onClick={() => onFileClick(f.path)}
          >
            <span className={`gp-letter gp-letter-${f.status}`}>{f.status}</span>
            <span className="gpd-file-name">{f.path.split("/").pop()}</span>
            {f.oldPath && <span className="gpd-old">← {f.oldPath.split("/").pop()}</span>}
          </div>
        ))}
    </>
  );
  return <div className="gpd-filetree">{render(rootNode, "", 0)}</div>;
}

/** Working-tree change rows rendered as a collapsible directory tree ("tree" view). */
function WorkingTreeRows({
  items,
  renderLeaf,
}: {
  items: { path: string; letter: string | null }[];
  renderLeaf: (item: { path: string; letter: string | null }) => React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  type Node = { dirs: Map<string, Node>; files: { path: string; letter: string | null }[] };
  const rootNode = useMemo<Node>(() => {
    const root: Node = { dirs: new Map(), files: [] };
    for (const f of items) {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const d = parts[i];
        if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
        node = node.dirs.get(d)!;
      }
      node.files.push(f);
    }
    return root;
  }, [items]);
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const render = (node: Node, prefix: string, depth: number): React.ReactNode => (
    <>
      {[...node.dirs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, child]) => {
          const key = `${prefix}${name}/`;
          const open = !collapsed.has(key);
          return (
            <div key={key}>
              <div className="gpd-dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(key)}>
                <ChevronRight size={10} className={open ? "gpd-caret-open" : ""} />
                <span className="gpd-dir-name">{name}</span>
                <span className="gpd-dir-count">{child.files.length + child.dirs.size}</span>
              </div>
              {open && render(child, key, depth + 1)}
            </div>
          );
        })}
      {[...node.files]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => (
          <div key={f.path} style={{ paddingLeft: 10 + depth * 14 + 16 }}>
            {renderLeaf(f)}
          </div>
        ))}
    </>
  );
  return <div className="gpd-filetree">{render(rootNode, "", 0)}</div>;
}

/** Expanded commit detail: full hash/meta, message body, changed-file tree. */
function CommitDetailView({ root, d }: { root: string; d: GitCommitDetail }) {
  const language = useStore((s) => s.config?.language || "en");
  const openPreview = useStore((s) => s.openPreview);
  const t = (zh: string, en: string) => (language === "zh" ? zh : en);

  return (
    <>
      <div className="gpd-head">
        <span className="gpd-hash" title={d.hash}>
          {d.hash}
        </span>
        <span className="gpd-meta">
          {d.author} · {d.rel}
        </span>
        <span className="gpd-date" title={d.date}>
          {d.date.slice(0, 10)}
        </span>
      </div>
      {d.message && <pre className="gpd-msg">{d.message}</pre>}
      <div className="gpd-files-head">
        <span>{t("变更文件", "Changed files")}</span>
        <span className="pcount">{d.files.length}</span>
      </div>
      <CommitFileTree
        files={d.files}
        onFileClick={(path) => void openPreview(`${root}/${path}`, root, d.hash)}
      />
    </>
  );
}

/** Sidebar Git tab: status (staged/changes/untracked), commit box, history, pull/push. */
export function GitPanel({ cwd }: { cwd: string | null }) {
  const language = useStore((s) => s.config?.language || "en");
  const openPreview = useStore((s) => s.openPreview);
  // re-render only when the set of streaming threads changes; a finished run
  // may have modified the working tree, so it triggers a status refresh.
  const runningKey = useStore((s) =>
    Object.keys(s.threads)
      .filter((id) => s.threads[id].isStreaming)
      .sort()
      .join("\x00")
  );

  const t = (zh: string, en: string) => (language === "zh" ? zh : en);

  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySkip, setHistorySkip] = useState(0);
  const [logBusy, setLogBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, GitCommitDetail | null>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<"flat" | "tree">(() => {
    try {
      return localStorage.getItem("pi-studio.git-view") === "tree" ? "tree" : "flat";
    } catch {
      return "flat";
    }
  });
  const switchView = (mode: "flat" | "tree") => {
    setViewMode(mode);
    try {
      localStorage.setItem("pi-studio.git-view", mode);
    } catch {
      /* non-persistent view toggle is fine */
    }
  };
  const branchRef = useRef<HTMLDivElement>(null);
  useOutsideClose(branchRef, branchOpen, () => setBranchOpen(false));

  const root = status?.repo ? status.root : null;

  // Drop out-of-order responses: after a tab switch a slow refresh from the
  // previous repo must not clobber the active one (which would also point
  // commits/discards at the wrong repo via `root`).
  const refreshSeq = useRef(0);
  const prevCwdRef = useRef<string | null>(null);

  // History modes: a search query searches all history; otherwise the default
  // view is the last 3 days (older pages drop the window and paginate via skip).
  const fetchLog = async (target: string, opts: GitLogOpts = {}): Promise<GitLogEntry[]> => {
    const { query, skip, limit = 200 } = opts;
    if (query) return window.pi.git.log(target, { limit, query, skip }).catch(() => []);
    if (skip) return window.pi.git.log(target, { limit, skip }).catch(() => []);
    return window.pi.git.log(target, { limit, since: "3 days ago" }).catch(() => []);
  };

  const refresh = async (target: string) => {
    const seq = ++refreshSeq.current;
    const [st, br, lg] = await Promise.all([
      window.pi.git.status(target).catch(() => null),
      window.pi.git.branches(target).catch(() => []),
      fetchLog(target, { query: historyQuery.trim() }),
    ]);
    if (seq !== refreshSeq.current) return; // superseded by a newer refresh
    setStatus(st);
    setBranches(br || []);
    setLog(lg || []);
    setHistorySkip(0);
    setHasMore((lg || []).length >= 200);
  };

  // Debounced history search; clears back to the 3-day default view. Bumping
  // refreshSeq keeps it from racing an in-flight refresh().
  useEffect(() => {
    const seq = ++refreshSeq.current;
    const q = historyQuery.trim();
    if (!cwd) return;
    const timer = setTimeout(async () => {
      const lg = await fetchLog(cwd, { query: q });
      if (seq !== refreshSeq.current) return;
      setLog(lg);
      setHistorySkip(0);
      setHasMore(lg.length >= 200);
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [cwd, historyQuery]);

  useEffect(() => {
    refreshSeq.current++; // invalidate any in-flight refresh from the previous repo
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    if (!cwd) {
      setStatus(null);
      setBranches([]);
      setLog([]);
      setHistoryQuery("");
      setHistorySkip(0);
      setExpandedHash(null);
      setDetailCache({});
      setMessage("");
      return;
    }
    if (cwdChanged) {
      // Never keep showing the previous tab's repo while the new one loads.
      setStatus(null);
      setHistoryQuery("");
      setHistorySkip(0);
      setExpandedHash(null);
      setDetailCache({});
      setMessage("");
    }
    void refresh(cwd);
    // runningKey: refresh when a run starts/stops (agent edits land on disk).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, runningKey]);

  const run = async (action: Promise<GitOpResult>, opts: { keepMessage?: boolean } = {}) => {
    if (!root || busy) return;
    setBusy(true);
    try {
      const r = await action;
      if (!r.ok) {
        useStore.getState().pushToast("error", r.error || t("操作失败", "Operation failed"));
      } else if (!opts.keepMessage) {
        setMessage("");
      }
      await refresh(root);
    } finally {
      setBusy(false);
    }
  };

  const commit = () => {
    if (!root) return;
    const text = message.trim();
    if (!text) {
      useStore.getState().pushToast("info", t("先填写提交说明", "Enter a commit message first"));
      return;
    }
    void run(
      (async () => {
        // Nothing staged → stage everything, mirroring "commit all" behavior.
        if (status && status.staged.length === 0) {
          const s = await window.pi.git.stageAll(root);
          if (!s.ok) return s;
        }
        return window.pi.git.commit({ cwd: root, message: text });
      })(),
    );
  };

  const discard = (tracked: string[], untracked: string[]) => {
    if (!root) return;
    const n = tracked.length + untracked.length;
    const warn = untracked.length
      ? t(`放弃 ${n} 个文件的更改？未跟踪文件将被删除，此操作不可撤销。`, `Discard ${n} file(s)? Untracked files are deleted. This cannot be undone.`)
      : t(`放弃 ${n} 个文件的更改？此操作不可撤销。`, `Discard changes in ${n} file(s)? This cannot be undone.`);
    if (!window.confirm(warn)) return;
    void run(window.pi.git.discard({ cwd: root, tracked, untracked }), { keepMessage: true });
  };

  const checkout = (branch: string) => {
    setBranchOpen(false);
    if (!root || branch === status?.branch) return;
    void run(window.pi.git.checkout({ cwd: root, branch }), { keepMessage: true });
  };

  const generateMessage = async () => {
    if (!root || generating) return;
    setGenerating(true);
    try {
      const r = await window.pi.git.generateMessage(root);
      if (r.ok && r.output) setMessage(r.output);
      else useStore.getState().pushToast("error", r.error || t("生成失败", "Generation failed"));
    } finally {
      setGenerating(false);
    }
  };

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  const loadMore = async () => {
    if (!root || logBusy) return;
    setLogBusy(true);
    try {
      const q = historyQuery.trim();
      const batch = await fetchLog(root, { query: q || undefined, skip: historySkip, limit: 50 });
      if (batch.length === 0) {
        setHasMore(false);
        return;
      }
      setLog((prev) => [...prev, ...batch]);
      setHistorySkip((s) => s + batch.length);
      setHasMore(batch.length >= 50);
    } finally {
      setLogBusy(false);
    }
  };

  const openCommit = async (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(hash);
    if (detailCache[hash] !== undefined || !root || detailLoading) return;
    setDetailLoading(hash);
    const d = await window.pi.git.commitDetail(root, hash);
    setDetailCache((c) => ({ ...c, [hash]: d }));
    setDetailLoading((cur) => (cur === hash ? null : cur));
  };

  const fileRows = useMemo(() => {
    if (!status?.repo || !root) return null;
    const row = (path: string, letter: string | null, actions: React.ReactNode) => {
      const name = path.split("/").pop() || path;
      const ext = name.includes(".") ? name.split(".").pop() || "" : "";
      return (
        <div
          className="gp-row"
          key={letter ? `${letter}:${path}` : `u:${path}`}
          title={path}
          onClick={() => letter !== "D" && openPreview(`${root}/${path}`, root)}
        >
          <span className="gp-ico">{fileIcon(ext, false)}</span>
          <span className="gp-name">{name}</span>
          <span className="gp-path">{path.slice(0, path.length - name.length).replace(/\/$/, "")}</span>
          {letter && <span className={`gp-letter gp-letter-${letter}`}>{letter}</span>}
          <span className="gp-row-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        </div>
      );
    };
    return { row };
  }, [status, root, openPreview]);

  if (!cwd) return <div className="ft-empty">{t("先在“会话”页打开一个项目。", "Open a project in the Sessions tab first.")}</div>;
  if (!status) return <div className="ft-empty">{t("加载中…", "Loading…")}</div>;
  if (!status.repo || !root || !fileRows) {
    return <div className="ft-empty">{t("当前项目不是 Git 仓库。", "The active project is not a git repository.")}</div>;
  }

  const { row } = fileRows;
  /** Flat rows or the same rows nested under a collapsible directory tree. */
  const rowsFor = (files: { path: string; letter: string | null }[], actions: (path: string, letter: string | null) => React.ReactNode) =>
    viewMode === "tree" ? (
      <WorkingTreeRows items={files} renderLeaf={(f) => row(f.path, f.letter, actions(f.path, f.letter))} />
    ) : (
      files.map((f) => row(f.path, f.letter, actions(f.path, f.letter)))
    );
  const totalChanges = status.staged.length + status.unstaged.length + status.untracked.length;
  const canCommit = !busy && !!message.trim() && totalChanges > 0;

  const section = (
    key: string,
    label: string,
    count: number,
    headAction: React.ReactNode,
    rows: React.ReactNode,
  ) => (
    <div className="gp-section" key={key}>
      <div className={`gp-section-head ${collapsed[key] ? "" : "open"}`} onClick={() => toggle(key)}>
        <span className="caret">
          <ChevronRight size={10} />
        </span>
        <span className="gp-section-label">{label}</span>
        <span className="pcount">{count}</span>
        {count > 0 && (
          <span className="gp-head-actions" onClick={(e) => e.stopPropagation()}>
            {headAction}
          </span>
        )}
      </div>
      {!collapsed[key] && count > 0 && <div className="gp-rows">{rows}</div>}
    </div>
  );

  return (
    <div className="gp">
      <div className="gp-toolbar">
        <div className="gp-branch" ref={branchRef}>
          <button className="gp-branch-btn" disabled={busy} onClick={() => setBranchOpen((o) => !o)} title={t("切换分支", "Switch branch")}>
            <Branch size={13} />
            <span className="gp-branch-name">{status.branch || t("游离头指针", "detached HEAD")}</span>
            <ChevronRight size={10} />
          </button>
          {branchOpen && (
            <div className="gp-branch-pop">
              {branches.length === 0 && <div className="ctx-empty">{t("暂无本地分支", "No local branches")}</div>}
              {branches.map((b) => (
                <button key={b} className={`gp-branch-item ${b === status.branch ? "active" : ""}`} onClick={() => checkout(b)}>
                  <span className="gp-branch-item-name">{b}</span>
                  {b === status.branch && <Check size={12} />}
                </button>
              ))}
              <div className="gp-wt-sep" />
              <button className="gp-wt-toggle" onClick={() => root && useStore.getState().openWorktreeFor(root, status?.branch)}>
                <Plus size={12} />
                {t("新建 worktree", "New worktree")}
              </button>
            </div>
          )}
        </div>
        <button
          className={`iconbtn gp-view-toggle${viewMode === "tree" ? " active" : ""}`}
          title={viewMode === "flat" ? t("树形显示", "Tree view") : t("扁平显示", "Flat view")}
          onClick={() => switchView(viewMode === "flat" ? "tree" : "flat")}
        >
          {viewMode === "flat" ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
              <path d="M2 2.5h4l2 2h6v9H2z" />
              <path d="M2 10.5h4M6 6v4.5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 3.5h12M2 8h12M2 12.5h8" />
            </svg>
          )}
        </button>
        <button
          className="iconbtn"
          title={t("刷新", "Refresh")}
          disabled={busy}
          onClick={() => void refresh(root)}
        >
          <Refresh size={13} />
        </button>
      </div>

      <div className="gp-message-wrap">
        <textarea
          className="gp-message"
          placeholder={t("填写提交说明", "Commit message")}
          value={message}
          rows={3}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          className={`gp-ai ${generating ? "spin" : ""}`}
          title={generating ? t("生成中…", "Generating…") : t("AI 生成提交说明", "Generate message with AI")}
          disabled={busy || generating || totalChanges === 0}
          onClick={generateMessage}
        >
          <Sparkle size={13} />
        </button>
      </div>
      <button className="btn primary gp-commit" disabled={!canCommit} onClick={commit}>
        {busy ? t("处理中…", "Working…") : status.staged.length > 0 ? t("提交", "Commit") : t("全部提交", "Commit all")}
      </button>

      {section(
        "staged",
        t("已暂存", "Staged"),
        status.staged.length,
        <button className="gp-act" title={t("全部取消暂存", "Unstage all")} onClick={() => void run(window.pi.git.unstageAll(root), { keepMessage: true })}>
          <Minus size={13} />
        </button>,
        rowsFor(
          status.staged.map((f) => ({ path: f.path, letter: f.status })),
          (path) => (
            <button className="gp-act" title={t("取消暂存", "Unstage")} onClick={() => void run(window.pi.git.unstage({ cwd: root, paths: [path] }), { keepMessage: true })}>
              <Minus size={13} />
            </button>
          ),
        ),
      )}
      {section(
        "changes",
        t("更改", "Changes"),
        status.unstaged.length,
        <button className="gp-act" title={t("全部暂存", "Stage all")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: status.unstaged.map((f) => f.path) }), { keepMessage: true })}>
          <Plus size={13} />
        </button>,
        rowsFor(
          status.unstaged.map((f) => ({ path: f.path, letter: f.status })),
          (path) => (
            <>
              <button className="gp-act" title={t("放弃更改", "Discard changes")} onClick={() => discard([path], [])}>
                <Undo size={12} />
              </button>
              <button className="gp-act" title={t("暂存", "Stage")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: [path] }), { keepMessage: true })}>
                <Plus size={13} />
              </button>
            </>
          ),
        ),
      )}
      {section(
        "untracked",
        t("未跟踪", "Untracked"),
        status.untracked.length,
        <button className="gp-act" title={t("全部暂存", "Stage all")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: status.untracked }), { keepMessage: true })}>
          <Plus size={13} />
        </button>,
        rowsFor(
          status.untracked.map((p) => ({ path: p, letter: null })),
          (path) => (
            <>
              <button className="gp-act" title={t("删除文件", "Delete file")} onClick={() => discard([], [path])}>
                <Undo size={12} />
              </button>
              <button className="gp-act" title={t("暂存", "Stage")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: [path] }), { keepMessage: true })}>
                <Plus size={13} />
              </button>
            </>
          ),
        ),
      )}
      {totalChanges === 0 && <div className="ft-empty">{t("工作区干净，没有待提交的更改。", "Working tree clean.")}</div>}

      <div className="gp-section gp-history">
        <div className={`gp-section-head ${collapsed.history ? "" : "open"}`} onClick={() => toggle("history")}>
          <span className="caret">
            <ChevronRight size={10} />
          </span>
          <span className="gp-section-label">
            {t("Git 历史", "History")}
            {!historyQuery.trim() && <span className="gp-log-window">{t("最近 3 天", "last 3 days")}</span>}
          </span>
          <span className="pcount">{log.length}</span>
        </div>
        {!collapsed.history && (
          <div className="gp-history-body">
            <input
              className="gp-history-search"
              placeholder={t("检索提交…", "Search commits…")}
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
            />
            <div className="gp-log">
              {log.length === 0 && <div className="ctx-empty">{t("暂无提交记录", "No commits yet")}</div>}
              {log.map((c) => (
                <Fragment key={c.hash}>
                  <div
                    className={`gp-log-row ${expandedHash === c.hash ? "active" : ""}`}
                    onClick={() => void openCommit(c.hash)}
                  >
                    <div className="gp-log-subject">
                      <span className="gp-log-subject-text">{c.subject}</span>
                      {c.refs && <span className="gp-log-refs">{c.refs}</span>}
                    </div>
                    <div className="gp-log-meta">
                      {c.author} · {c.rel} · {c.short}
                    </div>
                  </div>
                  {expandedHash === c.hash && (
                    <div className="gpd">
                      {detailLoading === c.hash ? (
                        <div className="ctx-empty">{t("加载中…", "Loading…")}</div>
                      ) : detailCache[c.hash] ? (
                        <CommitDetailView root={root} d={detailCache[c.hash]!} />
                      ) : (
                        <div className="ctx-empty">{t("无法加载提交详情", "Failed to load commit details")}</div>
                      )}
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
            {hasMore && (
              <button className="gp-log-more" disabled={logBusy} onClick={loadMore}>
                {logBusy ? t("加载中…", "Loading…") : t("加载更多", "Load more")}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="gp-foot">
        <span className="gp-foot-branch" title={status.upstream || status.branch || ""}>
          {status.branch || "HEAD"}
          {status.upstream ? (
            <span className="gp-foot-ab">
              +{status.ahead} -{status.behind}
            </span>
          ) : (
            <span className="gp-foot-ab">{t("无上游", "no upstream")}</span>
          )}
        </span>
        <span className="sb-foot-spacer" aria-hidden="true" />
        <button className="gp-sync" disabled={busy} onClick={() => void run(window.pi.git.pull(root), { keepMessage: true })}>
          {t("拉取", "Pull")}
        </button>
        <button className="gp-sync" disabled={busy} onClick={() => void run(window.pi.git.push(root), { keepMessage: true })}>
          {t("推送", "Push")}
        </button>
      </div>
    </div>
  );
}
