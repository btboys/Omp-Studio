import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import { fileIcon, formatTokens } from "../lib/format";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { FileNode } from "../lib/types";
import { Plus, Close, Folder, Archive, ChevronRight, Edit, Clock, At, Search, Settings, Refresh, Gauge, Branch, Sidebar as SidebarIcon, Plug } from "./icons";
import { GitPanel } from "./GitPanel";
import { ThreadListModal } from "./ThreadListModal";

const treeKey = (cwd: string, rel?: string) => `${cwd}::${rel || ""}`;
const SIDEBAR_WIDTH_KEY = "pi-studio.sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 286;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const clampSidebarWidth = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

function initialSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function Sidebar() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const projects = useStore((s) => s.projects);
  const activeProjectCwd = useStore((s) => s.activeProjectCwd);
  const expandedProjects = useStore((s) => s.expandedProjects);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sidebarFlashThreadId = useStore((s) => s.sidebarFlashThreadId);
  const sidebarTab = useStore((s) => s.sidebarTab);
  const language = useStore((s) => s.config?.language || "en");

  // ids of threads currently streaming, joined into a stable string so this
  // component only re-renders when the running set changes (not on every token).
  const runningKey = useStore((s) =>
    Object.keys(s.threads)
      .filter((id) => s.threads[id].isStreaming)
      .sort()
      .join("\u0000")
  );
  const runningSet = useMemo(() => new Set(runningKey ? runningKey.split("\u0000") : []), [runningKey]);
  const projectByCwd = useMemo(() => new Map(projects.map((p) => [p.cwd, p])), [projects]);

  // git info per project worktree (branch + repo identity); refetched when the
  // project set changes or a run ends (the agent may have switched branches).
  const [gitInfos, setGitInfos] = useState<Record<string, { branch: string | null; commonDir: string | null; isLinked: boolean }>>({});
  const projectsKey = projects.map((p) => p.cwd).join(" ");
  useEffect(() => {
    if (!projects.length) {
      setGitInfos({});
      return;
    }
    let alive = true;
    Promise.all(projects.map((p) => window.pi.app.getGitInfo(p.cwd).catch(() => null))).then((list) => {
      if (!alive) return;
      const next: Record<string, { branch: string | null; commonDir: string | null; isLinked: boolean }> = {};
      projects.forEach((p, i) => {
        const info = list[i];
        if (info?.commonDir) next[p.cwd] = info;
      });
      setGitInfos(next);
    });
    return () => {
      alive = false;
    };
  }, [projectsKey, runningKey]);

  // User-defined project groups (config). Entries are sidebar item keys: a
  // project cwd OR a worktree container commonDir (a whole repo container can
  // live inside a group). Display order comes from projectOrder (top-level
  // items) with new groups appended.
  const projectGroups = useStore((s) => s.config?.projectGroups || {});
  const projectOrder = useStore((s) => s.config?.projectOrder || []);
  // All cwds claimed by groups: direct entries plus members of grouped containers.
  const groupedCwds = useMemo(() => {
    const set = new Set<string>();
    for (const entries of Object.values(projectGroups)) {
      for (const entry of entries) {
        if (projectByCwd.has(entry)) {
          set.add(entry);
        } else {
          for (const p of projects) if (gitInfos[p.cwd]?.commonDir === entry) set.add(p.cwd);
        }
      }
    }
    return set;
  }, [projectGroups, projects, gitInfos, projectByCwd]);

  // Group by repo identity (user groups take precedence: only ungrouped
  // projects participate). Every git repo becomes a pure container (no threads
  // of its own); members — main checkout first, then linked worktrees — are
  // branch children with their own thread lists. Non-git projects stay flat.
  const { flatProjects, worktreeGroups } = useMemo(() => {
    const byRepo: Record<string, string[]> = {};
    for (const p of projects) {
      if (groupedCwds.has(p.cwd)) continue;
      const common = gitInfos[p.cwd]?.commonDir;
      if (common) (byRepo[common] ||= []).push(p.cwd);
    }
    const grouped = new Set<string>();
    const groups: { commonDir: string; members: typeof projects }[] = [];
    for (const [common, cwds] of Object.entries(byRepo)) {
      const main = cwds.find((c) => !gitInfos[c]?.isLinked);
      const ordered = main ? [main, ...cwds.filter((c) => c !== main)] : cwds;
      groups.push({
        commonDir: common,
        members: ordered.map((c) => projectByCwd.get(c)!).filter(Boolean),
      });
      cwds.forEach((c) => grouped.add(c));
    }
    return { flatProjects: projects.filter((p) => !groupedCwds.has(p.cwd) && !grouped.has(p.cwd)), worktreeGroups: groups };
  }, [projects, gitInfos, projectByCwd, groupedCwds]);

  const repoName = (commonDir: string) => commonDir.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0] || commonDir;

  type TopItem =
    | { key: string; kind: "group"; name: string; entries: string[] }
    | { key: string; kind: "container"; name: string; container: (typeof worktreeGroups)[number] }
    | { key: string; kind: "project"; project: (typeof projects)[number] };

  // Every repo's container members by commonDir, regardless of grouping
  // (grouped containers render inside user groups from this map).
  const allContainers = useMemo(() => {
    const byKey = new Map<string, (typeof projects)[number][]>();
    for (const p of projects) {
      const common = gitInfos[p.cwd]?.commonDir;
      if (!common) continue;
      const list = byKey.get(common) || [];
      list.push(p);
      list.sort((a, b) => (gitInfos[a.cwd]?.isLinked ? 1 : 0) - (gitInfos[b.cwd]?.isLinked ? 1 : 0)); // main first
      byKey.set(common, list);
    }
    return byKey;
  }, [projects, gitInfos]);

  // Ordered top-level sidebar items: user groups / worktree containers / flat
  // projects, in projectOrder, with anything new appended (insertion order).
  const topItems = useMemo<TopItem[]>(() => {
    const groupNames = Object.keys(projectGroups);
    const containerByKey = new Map(worktreeGroups.map((g) => [g.commonDir, g]));
    const items: TopItem[] = [];
    const placed = new Set<string>();
    const appendItem = (key: string) => {
      if (placed.has(key)) return;
      if (projectGroups[key]) {
        const entries = (projectGroups[key] || []).filter((e) => projectByCwd.has(e) || allContainers.has(e));
        items.push({ key, kind: "group", name: key, entries });
        placed.add(key);
      } else if (containerByKey.has(key)) {
        const container = containerByKey.get(key)!;
        items.push({ key, kind: "container", name: repoName(key), container });
        placed.add(key);
      } else if (projectByCwd.has(key) && !groupedCwds.has(key)) {
        items.push({ key, kind: "project", project: projectByCwd.get(key)! });
        placed.add(key);
      }
    };
    for (const key of projectOrder) appendItem(key);
    for (const name of groupNames) appendItem(name);
    for (const g of worktreeGroups) appendItem(g.commonDir);
    for (const p of flatProjects) appendItem(p.cwd);
    return items;
  }, [projectOrder, projectGroups, worktreeGroups, flatProjects, projectByCwd, groupedCwds, allContainers]);

  // drag & drop state for project reordering / regrouping
  type DragItem = { key: string; kind: "project" | "group" | "container" };
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dragHover, setDragHover] = useState<{ key: string; pos: "before" | "after" | "in" } | null>(null);
  const clearDrag = () => {
    setDragItem(null);
    setDragHover(null);
  };

  /** Recompute projectOrder + projectGroups after a drop and persist them.
   *  Items are project cwds or worktree container commonDirs; both may live at
   *  the top level or inside a user group (a group can hold a whole container). */
  const handleDrop = (item: DragItem, target: { key: string; kind: "project" | "group" | "container" }, pos: "before" | "after" | "in") => {
    const order = [...projectOrder];
    const groups: Record<string, string[]> = {};
    for (const [name, members] of Object.entries(projectGroups)) groups[name] = [...members];
    if (item.kind === "group") {
      // group containers only reorder at the top level
      const nextOrder = order.filter((e) => e !== item.key);
      const i = nextOrder.indexOf(target.key);
      if (i < 0) nextOrder.push(item.key);
      else nextOrder.splice(pos === "before" ? i : i + 1, 0, item.key);
      useStore.getState().applyProjectLayout(nextOrder, groups);
      return;
    }
    // project or worktree container: can join / leave / reorder within groups
    for (const [name, members] of Object.entries(groups)) groups[name] = members.filter((c) => c !== item.key);
    let nextOrder = order.filter((e) => e !== item.key);
    const targetGroup = Object.keys(groups).find((name) => groups[name].includes(target.key));
    if (target.kind === "group" && pos === "in") {
      // drop onto a group head/body: move into that group (append)
      groups[target.key] = [...(groups[target.key] || []), item.key];
      if (!nextOrder.includes(target.key)) nextOrder.push(target.key);
    } else if (targetGroup) {
      // drop onto a member of a user group: move into that group at position
      const members = groups[targetGroup].filter((c) => c !== item.key);
      const i = members.indexOf(target.key);
      members.splice(i < 0 ? members.length : pos === "before" ? i : i + 1, 0, item.key);
      groups[targetGroup] = members;
    } else {
      // drop onto a top-level item: ungroup + reorder at top level
      const i = nextOrder.indexOf(target.key);
      if (i < 0) nextOrder.push(item.key);
      else nextOrder.splice(pos === "before" ? i : i + 1, 0, item.key);
    }
    useStore.getState().applyProjectLayout(nextOrder, groups);
  };

  /** before/after by pointer Y midpoint; group heads always accept projects/containers as "in". */
  const dropPosFor = (e: ReactDragEvent, targetKind: "project" | "group" | "container"): "before" | "after" | "in" => {
    if (targetKind === "group" && dragItem?.kind !== "group") return "in";
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const headDragProps = (item: DragItem, drop: boolean) => ({
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.key);
      setDragItem(item);
    },
    onDragEnd: clearDrag,
    ...(drop
      ? {
          onDragOver: (e: ReactDragEvent) => {
            if (!dragItem) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragHover({ key: item.key, pos: dropPosFor(e, item.kind) });
          },
          onDragLeave: () => setDragHover((h) => (h?.key === item.key ? null : h)),
          onDrop: (e: ReactDragEvent) => {
            e.preventDefault();
            if (dragItem) handleDrop(dragItem, item, dropPosFor(e, item.kind));
            clearDrag();
          },
        }
      : {}),
  });

  const groupHoverClass = (key: string) => (dragHover?.key === key ? ` drag-${dragHover.pos}` : "");

  /** A worktree repo container: head + worktree members. ctx "group" = inside a user group. */
  const renderContainer = (commonDir: string, members: (typeof projects)[number][], ctx: "top" | "group") => {
    const open = !collapsedGroups.has(commonDir);
    return (
      <div className={`project worktree-group ${ctx === "group" ? "container-in-group" : ""}`} key={commonDir}>
        <div
          className={`project-head group-head ${open ? "open" : ""}${groupHoverClass(commonDir)}`}
          {...headDragProps({ key: commonDir, kind: "container" }, true)}
          onClick={() => toggleGroup(commonDir)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setProjectMenu({
              members: [commonDir],
              name: repoName(commonDir),
              x: Math.min(event.clientX, window.innerWidth - 190),
              y: Math.min(event.clientY, window.innerHeight - 70),
            });
          }}
        >
          <span className="caret">
            <ChevronRight size={10} />
          </span>
          <Folder size={15} />
          <span className="pname" title={`${commonDir} · ${members.length} 个分支`}>
            {repoName(commonDir)}
          </span>
          <div className="pactions">
            <span className="pcount">{members.length}</span>
          </div>
        </div>
        {open && <div className="worktree-members">{members.map((m) => renderProject(m, "none"))}</div>}
      </div>
    );
  };

  // collapsed repo containers (default expanded)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (commonDir: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(commonDir)) next.delete(commonDir);
      else next.add(commonDir);
      return next;
    });
  };
  // collapsed user-defined project groups (default expanded)
  const [collapsedUserGroups, setCollapsedUserGroups] = useState<Set<string>>(new Set());
  const toggleUserGroup = (name: string) => {
    setCollapsedUserGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  /** Context menu for a user group head: rename / delete. */
  const [groupMenu, setGroupMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  useOutsideClose(groupMenuRef, !!groupMenu, () => setGroupMenu(null));
  // Inline group-name input (Electron has no window.prompt). mode:
  // create (optionally moving a project in) / rename.
  const [groupPrompt, setGroupPrompt] = useState<{ mode: "create"; moveCwd?: string; moveAll?: string[]; x: number; y: number } | { mode: "rename"; oldName: string; x: number; y: number } | null>(null);
  const [groupPromptValue, setGroupPromptValue] = useState("");
  const groupPromptRef = useRef<HTMLDivElement>(null);
  useOutsideClose(groupPromptRef, !!groupPrompt, () => setGroupPrompt(null));
  const submitGroupPrompt = () => {
    const value = groupPromptValue.trim();
    const prompt = groupPrompt;
    setGroupPrompt(null);
    setGroupPromptValue("");
    if (!value) return;
    if (prompt?.mode === "create") {
      void useStore.getState().createProjectGroup(value).then(() => {
        if (prompt.moveAll?.length) void useStore.getState().moveItemsToGroup(prompt.moveAll, value);
        else if (prompt.moveCwd) void useStore.getState().moveItemsToGroup([prompt.moveCwd], value);
      });
    } else if (prompt?.mode === "rename" && value !== prompt.oldName) {
      void useStore.getState().renameProjectGroup(prompt.oldName, value);
    }
  };

  // total-usage popover (sidebar footer)
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageData, setUsageData] = useState<any>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  /** members = worktree-repo container menu (applies group actions to all members). */
  const [projectMenu, setProjectMenu] = useState<{ cwd?: string; members?: string[]; name: string; x: number; y: number } | null>(null);
  /** Project whose full session list is open in the paginated/searchable modal. */
  const [threadListCwd, setThreadListCwd] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const usageRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  useOutsideClose(usageRef, usageOpen, () => setUsageOpen(false));
  useOutsideClose(projectMenuRef, !!projectMenu, () => setProjectMenu(null));
  // Context menus grew with the group actions: when a menu would overflow the
  // window bottom/right edge, flip it above/left of the cursor instead.
  const flipMenu = <T extends { x: number; y: number }>(menu: T, el: HTMLElement | null): T => {
    if (!el) return menu;
    const pad = 8;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let { x, y } = menu;
    if (r.bottom > vh - pad) y = Math.max(pad, menu.y - r.height - pad);
    if (r.right > vw - pad) x = Math.max(pad, menu.x - r.width - pad);
    return x === menu.x && y === menu.y ? menu : { ...menu, x, y };
  };
  useLayoutEffect(() => {
    if (!projectMenu || !projectMenuRef.current) return;
    const fixed = flipMenu(projectMenu, projectMenuRef.current);
    if (fixed !== projectMenu) setProjectMenu(fixed);
  }, [projectMenu]);
  useLayoutEffect(() => {
    if (!groupMenu || !groupMenuRef.current) return;
    const fixed = flipMenu(groupMenu, groupMenuRef.current);
    if (fixed !== groupMenu) setGroupMenu(fixed);
  }, [groupMenu]);

  useEffect(() => {
    if (!sidebarFlashThreadId) return;
    const el = document.querySelector(`[data-thread-file="${CSS.escape(sidebarFlashThreadId)}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [sidebarFlashThreadId]);


  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      drag.width = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
      setSidebarWidth(drag.width);
    };
    const onPointerUp = () => {
      const drag = resizeRef.current;
      if (!drag) return;
      resizeRef.current = null;
      document.body.classList.remove("sidebar-resizing");
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(drag.width)));
      } catch {
        // A persisted width is convenient, but resizing must still work when
        // storage is unavailable.
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth, width: sidebarWidth };
    document.body.classList.add("sidebar-resizing");
  };

  const persistSidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    } catch {
      // See pointer-up persistence note above.
    }
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistSidebarWidth(sidebarWidth - 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistSidebarWidth(sidebarWidth + 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    }
  };

  const loadUsage = async () => {
    setUsageLoading(true);
    try {
      setUsageData(await window.pi.app.getTotalUsage());
    } catch {
      setUsageData(null);
    }
    setUsageLoading(false);
  };
  const toggleUsage = () => {
    const next = !usageOpen;
    setUsageOpen(next);
    if (next) loadUsage();
  };

  const toggleProject = useStore((s) => s.toggleProject);
  const openThread = useStore((s) => s.openThread);
  const goToThread = useStore((s) => s.goToThread);
  const openProjectFolder = useStore((s) => s.openProjectFolder);
  const archiveProject = useStore((s) => s.archiveProject);
  const removeProject = useStore((s) => s.removeProject);
  const archiveThread = useStore((s) => s.archiveThread);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const threadListProject = threadListCwd ? projects.find((p) => p.cwd === threadListCwd) || null : null;

  if (!sidebarOpen) return null;

  const newTask = async () => {
    const cwd = useStore.getState().activeProjectCwd;
    if (!cwd) {
      await openProjectFolder();
      return;
    }
    await openThread(cwd);
  };

  const onThreadClick = (cwd: string, file: string) => {
    void goToThread(cwd, file);
  };

  /** ctx: "top" = top-level flat project, "group" = user-group member, "none" = worktree member (no drag). */
  const renderProject = (p: (typeof projects)[number], ctx: "top" | "group" | "none" = "top") => {
    const open = !!expandedProjects[p.cwd];
    const branch = gitInfos[p.cwd]?.branch;
    const nested = ctx !== "top";
    const label = nested ? branch || p.name : p.name;
    const item: DragItem = { key: p.cwd, kind: "project" };
    return (
      <div className={`project ${nested ? "worktree-child" : ""}`} key={p.cwd}>
        <div
          className={`project-head ${open ? "open" : ""}${groupHoverClass(p.cwd)}`}
          {...(ctx === "none" ? {} : headDragProps(item, true))}
          onClick={() => toggleProject(p.cwd)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setProjectMenu({
              cwd: p.cwd,
              name: p.name,
              x: Math.min(event.clientX, window.innerWidth - 190),
              y: Math.min(event.clientY, window.innerHeight - 70),
            });
          }}
        >
          <span className="caret">
            <ChevronRight size={10} />
          </span>
          {nested ? <Branch size={14} /> : <Folder size={15} />}
          <span className="pname" title={branch ? `${p.cwd} · ${branch}` : p.cwd}>
            {label}
          </span>
          <div className="pactions">
            <span className="pcount">{p.threads.length}</span>
            {gitInfos[p.cwd]?.commonDir && (
              <button
                className="pact"
                title={language === "zh" ? "新建 worktree" : "New worktree"}
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().openWorktreeFor(p.cwd, gitInfos[p.cwd]?.branch);
                }}
              >
                <Branch size={13} />
              </button>
            )}
            <button
              className="pact"
              title="新建会话"
              onClick={(e) => {
                e.stopPropagation();
                openThread(p.cwd);
              }}
            >
              <Plus size={13} />
            </button>
            <button
              className="pact"
              title="从侧栏移除"
              onClick={(e) => {
                e.stopPropagation();
                void removeProject(p.cwd);
              }}
            >
              <Close size={13} />
            </button>
          </div>
        </div>
        {open && (
          <div className="thread-list">
            {p.threads.length === 0 && <div className="ft-empty">暂无会话</div>}
            {p.threads.slice(0, 10).map((t) => {
              const running = runningSet.has(t.file);
              const openThread = () => onThreadClick(p.cwd, t.file);
              return (
                <div
                  key={t.file}
                  data-thread-file={t.file}
                  className={`thread ${activeThreadId === t.file ? "active" : ""}${sidebarFlashThreadId === t.file ? " flash" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={openThread}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openThread();
                    }
                  }}
                  title={t.title}
                >
                  <div className="thread-title">
                    {running && <span className="thread-running" />}
                    <span className="tt-text">{t.title}</span>
                    <button
                      type="button"
                      className="thread-archive-btn"
                      title="归档会话"
                      aria-label={`归档会话：${t.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void archiveThread(p.cwd, t.file, t.title);
                      }}
                    >
                      <Archive size={13} />
                    </button>
                  </div>
                  {t.preview && t.preview !== t.title && <div className="thread-preview">{t.preview}</div>}
                  <div className="thread-meta">
                    {t.messageCount} 条 · {new Date(t.updatedAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              );
            })}
            {p.threads.length > 10 && (
              <button
                className="thread-more"
                onClick={() => setThreadListCwd(p.cwd)}
                title={language === "zh" ? "检索并分页查看全部会话" : "Search and browse all sessions"}
              >
                {language === "zh" ? `更多 ${p.threads.length - 10} 个会话` : `More ${p.threads.length - 10} sessions`}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={language === "zh" ? "调整侧边栏宽度" : "Resize sidebar"}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        title={language === "zh" ? "拖动调整侧边栏宽度；双击恢复默认" : "Drag to resize; double-click to reset"}
      />
      <div className="sb-head">
        <div className="sb-head-actions">
          <button className="sb-head-btn" title="搜索会话与文件" onClick={() => useStore.getState().openSearch()}>
            <Search size={16} />
          </button>
          <button className="sb-head-btn" title="折叠侧栏" aria-label="折叠侧栏" onClick={toggleSidebar}>
            <SidebarIcon size={16} />
          </button>
        </div>
        <div className="sb-head-actions">
          <button className="sb-head-btn" title="Settings" onClick={() => useStore.getState().openSettings()}>
            <Settings size={15} />
          </button>
          <div className="usage-wrap" ref={usageRef}>
            <button className={`sb-head-btn ${usageOpen ? "on" : ""}`} title="omp 合计 token 用量" onClick={toggleUsage}>
              <Gauge size={15} />
            </button>
            {usageOpen && (
              <div className="usage-pop">
                <div className="usage-pop-head">
                  <span>omp 合计用量</span>
                  <button className="ctx-refresh" title="刷新" onClick={loadUsage}>
                    <Refresh size={12} />
                  </button>
                </div>
                {usageLoading ? (
                  <div className="ctx-loading">
                    <span className="spinner" />
                  </div>
                ) : usageData ? (
                  <>
                    <div className="usage-bignum">{formatTokens(usageData.tokens)}</div>
                    <div className="usage-sub">tokens · {usageData.sessions} 个会话</div>
                    {usageData.cost > 0 && <div className="usage-cost">合计 ${usageData.cost.toFixed(4)}</div>}
                  </>
                ) : (
                  <div className="ctx-empty">暂无用量数据</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="sb-nav">
          <button className="sb-nav-item" onClick={newTask}>
            <span className="ico">
              <Edit size={15} />
            </span>
            新建任务
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openAutomation()}>
            <span className="ico">
              <Clock size={15} />
            </span>
            自动化
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openMcp()}>
            <span className="ico">
              <Plug size={15} />
            </span>
            MCP
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openPlugins()}>
            <span className="ico">
              <At size={15} />
            </span>
            插件
          </button>
        </div>

      <div className="sb-scroll">
        {sidebarTab === "threads" ? (
          <>
            <div className="sb-section-head">
              <span>项目</span>
              <button onClick={openProjectFolder} title="Open folder">
                <Plus size={14} />
              </button>
            </div>
            <div className="sb-project-list">
              {projects.length === 0 && <div className="ft-empty">尚无项目，点击 + 打开一个文件夹。</div>}
              {topItems.map((item) => {
                if (item.kind === "group") {
                  const open = !collapsedUserGroups.has(item.key);
                  return (
                    <div className="project worktree-group user-group" key={item.key}>
                      <div
                        className={`project-head group-head ${open ? "open" : ""}${groupHoverClass(item.key)}`}
                        {...headDragProps({ key: item.key, kind: "group" }, true)}
                        onClick={() => toggleUserGroup(item.key)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setGroupMenu({
                            name: item.key,
                            x: Math.min(event.clientX, window.innerWidth - 190),
                            y: Math.min(event.clientY, window.innerHeight - 70),
                          });
                        }}
                      >
                        <span className="caret">
                          <ChevronRight size={10} />
                        </span>
                        <Folder size={15} />
                        <span className="pname" title={`${item.key} · ${item.entries.length} 个条目`}>
                          {item.name}
                        </span>
                        <div className="pactions">
                          <span className="pcount">{item.entries.length}</span>
                        </div>
                      </div>
                      {open && (
                        <div
                          className="worktree-members"
                          onDragOver={(e) => {
                            if (dragItem && dragItem.kind !== "group") {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              setDragHover({ key: item.key, pos: "in" });
                            }
                          }}
                          onDragLeave={() => setDragHover((h) => (h?.key === item.key ? null : h))}
                          onDrop={(e) => {
                            if (dragItem && dragItem.kind !== "group") {
                              e.preventDefault();
                              handleDrop(dragItem, item, "in");
                            }
                            clearDrag();
                          }}
                        >
                          {item.entries.length === 0 && (
                            <div className="ft-empty drag-drop-hint">{language === "zh" ? "将项目或仓库拖到这里加入分组" : "Drag projects or repos here to group them"}</div>
                          )}
                          {item.entries.map((entry) => {
                            const proj = projectByCwd.get(entry);
                            if (proj) return renderProject(proj, "group");
                            const members = allContainers.get(entry);
                            return members?.length ? renderContainer(entry, members, "group") : null;
                          })}
                        </div>
                      )}
                    </div>
                  );
                }
                if (item.kind === "container") {
                  return renderContainer(item.key, item.container.members, "top");
                }
                return renderProject(item.project, "top");
              })}
            </div>
          </>
        ) : sidebarTab === "git" ? (
          <div className="sb-pane">
            <GitPanel cwd={activeProjectCwd} />
          </div>
        ) : (
          <div className="sb-pane">
            <FileTreeView cwd={activeProjectCwd} />
          </div>
        )}
      </div>

      <div className="sb-tabs">
        <button className={`sb-tab ${sidebarTab === "threads" ? "active" : ""}`} onClick={() => setSidebarTab("threads")}>
          会话
        </button>
        <button className={`sb-tab ${sidebarTab === "files" ? "active" : ""}`} onClick={() => setSidebarTab("files")}>
          文件
        </button>
        <button className={`sb-tab ${sidebarTab === "git" ? "active" : ""}`} onClick={() => setSidebarTab("git")}>
          Git
        </button>
      </div>
      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="project-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          role="menu"
        >
          <div className="project-context-name" title={projectMenu.cwd || (projectMenu.members || []).join("\n")}>{projectMenu.name}</div>
          {projectMenu.cwd && (
            <button
              role="menuitem"
              onClick={() => {
                const cwd = projectMenu.cwd!;
                setProjectMenu(null);
                archiveProject(cwd);
              }}
            >
              归档项目
            </button>
          )}
          <div className="project-context-sep" />
          <div className="project-context-label">{language === "zh" ? "移动到分组" : "Move to group"}</div>
          {Object.keys(projectGroups).map((name) => {
            const targets = projectMenu.members || [projectMenu.cwd!];
            const current = targets.every((c) => (projectGroups[name] || []).includes(c));
            return (
              <button
                key={name}
                role="menuitem"
                className={current ? "checked" : ""}
                onClick={() => {
                  const list = projectMenu.members || [projectMenu.cwd!];
                  setProjectMenu(null);
                  if (!current) void useStore.getState().moveItemsToGroup(list, name);
                }}
              >
                {current ? "✓ " : ""}
                {name}
              </button>
            );
          })}
          <button
            role="menuitem"
            onClick={() => {
              const list = projectMenu.members || [projectMenu.cwd!];
              const x = projectMenu.x;
              const y = projectMenu.y;
              setProjectMenu(null);
              setGroupPromptValue("");
              setGroupPrompt({ mode: "create", moveCwd: list.length === 1 ? list[0] : undefined, moveAll: list.length > 1 ? list : undefined, x, y });
            }}
          >
            {language === "zh" ? "新建分组并移入…" : "New group and move here…"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const list = projectMenu.members || [projectMenu.cwd!];
              setProjectMenu(null);
              void useStore.getState().moveItemsToGroup(list, null);
            }}
          >
            {language === "zh" ? "移到未分组" : "Ungroup"}
          </button>
        </div>
      )}
      {groupMenu && (
        <div ref={groupMenuRef} className="project-context-menu" style={{ left: groupMenu.x, top: groupMenu.y }} role="menu">
          <div className="project-context-name" title={groupMenu.name}>{groupMenu.name}</div>
          <button
            role="menuitem"
            onClick={() => {
              const name = groupMenu.name;
              const x = groupMenu.x;
              const y = groupMenu.y;
              setGroupMenu(null);
              setGroupPromptValue(name);
              setGroupPrompt({ mode: "rename", oldName: name, x, y });
            }}
          >
            {language === "zh" ? "重命名分组" : "Rename group"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const name = groupMenu.name;
              setGroupMenu(null);
              void useStore.getState().deleteProjectGroup(name);
            }}
          >
            {language === "zh" ? "删除分组" : "Delete group"}
          </button>
        </div>
      )}
      {groupPrompt && (
        <div ref={groupPromptRef} className="group-name-pop" style={{ left: groupPrompt.x, top: groupPrompt.y }} role="dialog">
          <input
            autoFocus
            value={groupPromptValue}
            placeholder={language === "zh" ? "分组名称" : "Group name"}
            onChange={(e) => setGroupPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitGroupPrompt();
              else if (e.key === "Escape") setGroupPrompt(null);
            }}
          />
          <div className="group-name-pop-actions">
            <button onClick={submitGroupPrompt}>{language === "zh" ? "确定" : "OK"}</button>
            <button onClick={() => setGroupPrompt(null)}>{language === "zh" ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}
      {threadListProject && <ThreadListModal project={threadListProject} onClose={() => setThreadListCwd(null)} />}
    </aside>
  );
}

function FileTreeView({ cwd }: { cwd: string | null }) {
  const loadFileTree = useStore((s) => s.loadFileTree);
  const fileTree = useStore((s) => s.fileTree);
  useEffect(() => {
    if (cwd && !fileTree[treeKey(cwd, "")]?.loaded) loadFileTree(cwd, "");
  }, [cwd, loadFileTree, fileTree]);
  if (!cwd) return <div className="ft-empty">先在“会话”页打开一个项目。</div>;
  const root = fileTree[treeKey(cwd, "")];
  if (!root?.loaded) return <div className="ft-empty">加载中…</div>;
  return (
    <div className="filetree">
      {root.nodes.map((n) => (
        <FileRow key={n.rel} cwd={cwd} node={n} depth={0} />
      ))}
    </div>
  );
}

function FileRow({ cwd, node, depth }: { cwd: string; node: FileNode; depth: number }) {
  const toggleFolder = useStore((s) => s.toggleFolder);
  const openPreview = useStore((s) => s.openPreview);
  const fileTree = useStore((s) => s.fileTree);
  const previewPath = useStore((s) => s.previewPath);
  const entry = node.isDir ? fileTree[treeKey(cwd, node.rel)] : undefined;
  const expanded = !!entry?.expanded;

  return (
    <>
      <div
        className={`ft-row ${!node.isDir && previewPath === node.abs ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (node.isDir ? toggleFolder(cwd, node.rel) : openPreview(node.abs, cwd))}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void window.pi.app.showFileContextMenu(node.abs);
        }}
        title={node.abs}
      >
        {node.isDir ? (
          <span className="ft-ico" style={{ transform: expanded ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>
            <ChevronRight size={11} />
          </span>
        ) : (
          <span className="ft-ico">{fileIcon(node.ext, false)}</span>
        )}
        <span className="ft-name">{node.name}</span>
      </div>
      {node.isDir && expanded && entry?.loaded && entry.nodes.map((c) => <FileRow key={c.rel} cwd={cwd} node={c} depth={depth + 1} />)}
    </>
  );
}
