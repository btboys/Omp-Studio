import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useOutsideClose } from "../lib/useOutsideClose";
import { fileIcon } from "../lib/format";
import type { GitLogEntry, GitOpResult, GitStatusResult } from "../lib/types";
import { Branch, Check, ChevronRight, Close, Minus, Plus, Refresh, Sparkle, Undo } from "./icons";

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
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [wtOpen, setWtOpen] = useState(false);
  const [wtBranch, setWtBranch] = useState("");
  const [wtPath, setWtPath] = useState("");
  const [wtPathTouched, setWtPathTouched] = useState(false);
  const [wtBusy, setWtBusy] = useState(false);
  const branchRef = useRef<HTMLDivElement>(null);
  useOutsideClose(branchRef, branchOpen, () => setBranchOpen(false));

  const root = status?.repo ? status.root : null;

  // Drop out-of-order responses: after a tab switch a slow refresh from the
  // previous repo must not clobber the active one (which would also point
  // commits/discards at the wrong repo via `root`).
  const refreshSeq = useRef(0);
  const prevCwdRef = useRef<string | null>(null);

  const refresh = async (target: string) => {
    const seq = ++refreshSeq.current;
    const [st, br, lg] = await Promise.all([
      window.pi.git.status(target).catch(() => null),
      window.pi.git.branches(target).catch(() => []),
      window.pi.git.log(target, 50).catch(() => []),
    ]);
    if (seq !== refreshSeq.current) return; // superseded by a newer refresh
    setStatus(st);
    setBranches(br || []);
    setLog(lg || []);
  };

  useEffect(() => {
    refreshSeq.current++; // invalidate any in-flight refresh from the previous repo
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;
    if (!cwd) {
      setStatus(null);
      setBranches([]);
      setLog([]);
      setMessage("");
      return;
    }
    if (cwdChanged) {
      // Never keep showing the previous tab's repo while the new one loads.
      setStatus(null);
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

  // Default worktree location: a sibling of the repo root named after the branch.
  const siblingPath = (branch: string) => {
    if (!root || !branch.trim()) return "";
    const sep = root.includes("\\") ? "\\" : "/";
    return `${root.slice(0, root.lastIndexOf(sep))}${sep}${branch.trim()}`;
  };

  const openWorktreeForm = () => {
    setWtBranch("");
    setWtPath("");
    setWtPathTouched(false);
    setWtOpen(true);
  };

  const createWorktree = async () => {
    if (!root || wtBusy || !wtBranch.trim() || !wtPath.trim()) return;
    setWtBusy(true);
    try {
      const r = await window.pi.git.worktreeAdd({ cwd: root, branch: wtBranch.trim(), path: wtPath.trim() });
      if (!r.ok) {
        useStore.getState().pushToast("error", r.error || t("创建 worktree 失败", "Failed to create worktree"));
        return;
      }
      useStore.getState().pushToast("success", t(`worktree 已创建：${r.path}`, `Worktree created: ${r.path}`));
      setBranchOpen(false);
      setWtOpen(false);
      setWtBranch("");
      setWtPath("");
      setWtPathTouched(false);
      if (r.path) await useStore.getState().openProjectPath(r.path);
    } finally {
      setWtBusy(false);
    }
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
              {wtOpen ? (
                <div className="gp-wt-form">
                  <input
                    className="gp-wt-input"
                    placeholder={t("新分支名", "New branch")}
                    value={wtBranch}
                    onChange={(e) => {
                      const v = e.target.value;
                      setWtBranch(v);
                      if (!wtPathTouched) setWtPath(siblingPath(v));
                    }}
                  />
                  <input
                    className="gp-wt-input"
                    placeholder={t("worktree 路径", "Worktree path")}
                    value={wtPath}
                    onChange={(e) => {
                      setWtPathTouched(true);
                      setWtPath(e.target.value);
                    }}
                  />
                  <div className="gp-wt-actions">
                    <button
                      className="btn primary gp-wt-create"
                      disabled={wtBusy || !wtBranch.trim() || !wtPath.trim()}
                      onClick={createWorktree}
                    >
                      {wtBusy ? t("创建中…", "Creating…") : t("创建 worktree", "Create worktree")}
                    </button>
                    <button
                      className="iconbtn"
                      title={t("取消", "Cancel")}
                      disabled={wtBusy}
                      onClick={() => setWtOpen(false)}
                    >
                      <Close size={12} />
                    </button>
                  </div>
                </div>
              ) : (
                <button className="gp-wt-toggle" onClick={openWorktreeForm}>
                  <Plus size={12} />
                  {t("新建 worktree", "New worktree")}
                </button>
              )}
            </div>
          )}
        </div>
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
        status.staged.map((f) =>
          row(f.path, f.status, (
            <button className="gp-act" title={t("取消暂存", "Unstage")} onClick={() => void run(window.pi.git.unstage({ cwd: root, paths: [f.path] }), { keepMessage: true })}>
              <Minus size={13} />
            </button>
          )),
        ),
      )}
      {section(
        "changes",
        t("更改", "Changes"),
        status.unstaged.length,
        <button className="gp-act" title={t("全部暂存", "Stage all")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: status.unstaged.map((f) => f.path) }), { keepMessage: true })}>
          <Plus size={13} />
        </button>,
        status.unstaged.map((f) =>
          row(f.path, f.status, (
            <>
              <button className="gp-act" title={t("放弃更改", "Discard changes")} onClick={() => discard([f.path], [])}>
                <Undo size={12} />
              </button>
              <button className="gp-act" title={t("暂存", "Stage")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: [f.path] }), { keepMessage: true })}>
                <Plus size={13} />
              </button>
            </>
          )),
        ),
      )}
      {section(
        "untracked",
        t("未跟踪", "Untracked"),
        status.untracked.length,
        <button className="gp-act" title={t("全部暂存", "Stage all")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: status.untracked }), { keepMessage: true })}>
          <Plus size={13} />
        </button>,
        status.untracked.map((p) =>
          row(p, null, (
            <>
              <button className="gp-act" title={t("删除文件", "Delete file")} onClick={() => discard([], [p])}>
                <Undo size={12} />
              </button>
              <button className="gp-act" title={t("暂存", "Stage")} onClick={() => void run(window.pi.git.stage({ cwd: root, paths: [p] }), { keepMessage: true })}>
                <Plus size={13} />
              </button>
            </>
          )),
        ),
      )}
      {totalChanges === 0 && <div className="ft-empty">{t("工作区干净，没有待提交的更改。", "Working tree clean.")}</div>}

      <div className="gp-section gp-history">
        <div className={`gp-section-head ${collapsed.history ? "" : "open"}`} onClick={() => toggle("history")}>
          <span className="caret">
            <ChevronRight size={10} />
          </span>
          <span className="gp-section-label">{t("Git 历史", "History")}</span>
          <span className="pcount">{log.length}</span>
        </div>
        {!collapsed.history && (
          <div className="gp-log">
            {log.length === 0 && <div className="ctx-empty">{t("暂无提交记录", "No commits yet")}</div>}
            {log.map((c) => (
              <div className="gp-log-row" key={c.hash} title={`${c.hash}\n${c.subject}`}>
                <div className="gp-log-subject">
                  <span className="gp-log-subject-text">{c.subject}</span>
                  {c.refs && <span className="gp-log-refs">{c.refs}</span>}
                </div>
                <div className="gp-log-meta">
                  {c.author} · {c.rel} · {c.short}
                </div>
              </div>
            ))}
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
