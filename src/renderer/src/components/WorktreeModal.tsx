import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useOutsideClose } from "../lib/useOutsideClose";
import { Folder } from "./icons";

/**
 * New-worktree dialog, shared by the Git panel toggle and the sidebar project
 * quick action. Driven by store overlay state: `worktreeRoot` is the repo to
 * fork, everything else is local to the dialog.
 */
export function WorktreeModal() {
  const language = useStore((s) => s.config?.language || "en");
  const worktreeOpen = useStore((s) => s.worktreeOpen);
  const root = useStore((s) => s.worktreeRoot);
  const closeWorktree = useStore((s) => s.closeWorktree);
  const t = (zh: string, en: string) => (language === "zh" ? zh : en);

  const [branches, setBranches] = useState<string[]>([]);
  const [wtNewBranch, setWtNewBranch] = useState(false);
  const [wtBranch, setWtBranch] = useState("");
  const [wtFrom, setWtFrom] = useState("");
  const [wtName, setWtName] = useState("");
  const [wtNameTouched, setWtNameTouched] = useState(false);
  const [wtLocation, setWtLocation] = useState("");
  const [wtPathExists, setWtPathExists] = useState(false);
  const [wtRandSuffix, setWtRandSuffix] = useState("");
  const [wtBusy, setWtBusy] = useState(false);
  const [homeDir, setHomeDir] = useState("");
  const modalRef = useRef<HTMLDivElement>(null);
  useOutsideClose(modalRef, worktreeOpen, () => {
    if (!wtBusy) closeWorktree();
  });

  // Home directory for the "~" shortcut in the location hint.
  useEffect(() => {
    void window.pi.app.getHomeDir().then(setHomeDir).catch(() => {});
  }, []);

  const sep = root?.includes("\\") ? "\\" : "/";
  const joinPath = (a: string, b: string) => (a.endsWith(sep) ? a + b : `${a}${sep}${b}`);
  const baseName = root ? root.split(/[\\/]/).filter(Boolean).pop() || "" : "";
  const randLetters = () =>
    Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz"[(Math.random() * 26) | 0]).join("");
  const wtPath = wtLocation.trim() && wtName.trim() ? joinPath(wtLocation.trim(), wtName.trim()) : "";
  const canCreate = !!wtPath && (wtNewBranch ? !!wtBranch.trim() : !!wtFrom) && !wtPathExists;

  // Reset + fetch branches each time the dialog opens on a repo.
  useEffect(() => {
    if (!worktreeOpen || !root) return;
    setBranches([]);
    setWtNewBranch(false);
    setWtBranch("");
    setWtFrom("");
    setWtNameTouched(false);
    setWtPathExists(false);
    setWtBusy(false);
    const suffix = randLetters();
    setWtRandSuffix(suffix);
    setWtName(baseName ? `${baseName}-${suffix}` : "");
    setWtLocation(root.slice(0, root.lastIndexOf(sep)));
    setWtFrom(useStore.getState().worktreeBranch || "");
    void window.pi.git
      .branches(root)
      .then((br) => setBranches(br || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeOpen, root]);

  // Debounced existence probe: block creation when the target directory
  // already exists under the chosen location.
  useEffect(() => {
    if (!worktreeOpen) return;
    const p = wtPath;
    if (!p) {
      setWtPathExists(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      const exists = await window.pi.app.fileExists(p).catch(() => false);
      if (alive) setWtPathExists(!!exists);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wtLocation, wtName, worktreeOpen]);

  const pickWorktreeFolder = async () => {
    const dir = await window.pi.app.showOpenDialog("folder");
    if (dir && !Array.isArray(dir)) setWtLocation(dir);
  };

  const createWorktree = async () => {
    if (!root || wtBusy || !canCreate) return;
    setWtBusy(true);
    try {
      const r = await window.pi.git.worktreeAdd({
        cwd: root,
        branch: wtNewBranch ? wtBranch.trim() : wtFrom,
        path: wtPath,
        newBranch: wtNewBranch,
        from: wtNewBranch ? wtFrom || undefined : undefined,
      });
      if (!r.ok) {
        useStore.getState().pushToast("error", r.error || t("创建 worktree 失败", "Failed to create worktree"));
        return;
      }
      useStore.getState().pushToast("success", t(`worktree 已创建：${r.path}`, `Worktree created: ${r.path}`));
      closeWorktree();
      if (r.path) await useStore.getState().openProjectPath(r.path);
    } finally {
      setWtBusy(false);
    }
  };

  if (!worktreeOpen || !root) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal wt-modal" ref={modalRef}>
        <div className="modal-title">{t("新建 worktree", "New Worktree")}</div>
        <div className="wt-row">
          <label className="wt-label">{t("来源分支", "From branch")}</label>
          <select className="wt-select" value={wtFrom} disabled={wtBusy} onChange={(e) => setWtFrom(e.target.value)}>
            <option value="">{t("选择分支", "Select branch")}</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className="wt-row">
          <label className="wt-check">
            <input type="checkbox" checked={wtNewBranch} disabled={wtBusy} onChange={(e) => setWtNewBranch(e.target.checked)} />
            <span>{t("新分支", "New branch")}</span>
          </label>
          <input
            className="wt-input"
            value={wtBranch}
            disabled={wtBusy || !wtNewBranch}
            placeholder={t("新分支名", "New branch name")}
            onChange={(e) => {
              const v = e.target.value;
              setWtBranch(v);
              if (!wtNameTouched && baseName) setWtName(v.trim() ? `${baseName}-${v.trim()}` : `${baseName}-${wtRandSuffix}`);
            }}
          />
        </div>
        <div className="wt-row">
          <label className="wt-label">{t("项目名", "Project name")}</label>
          <input
            className="wt-input"
            value={wtName}
            disabled={wtBusy}
            placeholder={t("目录名", "Directory name")}
            onChange={(e) => {
              setWtNameTouched(true);
              setWtName(e.target.value);
            }}
          />
        </div>
        <div className="wt-row">
          <label className="wt-label">{t("位置", "Location")}</label>
          <div className="wt-loc">
            <input className="wt-input" value={wtLocation} disabled={wtBusy} onChange={(e) => setWtLocation(e.target.value)} />
            <button className="iconbtn wt-folder" title={t("选择目录", "Choose folder")} disabled={wtBusy} onClick={() => void pickWorktreeFolder()}>
              <Folder size={14} />
            </button>
          </div>
        </div>
        <div className="wt-hint">
          {t("worktree 将创建在：", "The worktree will be created in: ")}
          {homeDir && (wtPath || wtLocation.trim()).startsWith(homeDir)
            ? `~${(wtPath || wtLocation.trim()).slice(homeDir.length)}`
            : wtPath || wtLocation.trim()}
        </div>
        {wtPathExists && <div className="wt-error">{t("该目录已存在，无法创建", "A directory with this name already exists")}</div>}
        <div className="wt-actions">
          <button className="btn" disabled={wtBusy} onClick={closeWorktree}>
            {t("取消", "Cancel")}
          </button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void createWorktree()}>
            {wtBusy ? t("创建中…", "Creating…") : t("创建并打开 Worktree", "Create & Open Worktree")}
          </button>
        </div>
      </div>
    </div>
  );
}
