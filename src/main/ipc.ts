import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { checkForAppUpdate, deferAppUpdate, downloadAppUpdate, installAppUpdate } from "./app-updater";
import { checkForCoreUpdate, installCoreUpdate } from "./core-updater";
import { getConfig, getConfigDir, updateConfig, type AutomationTask } from "./config";
import { listDir, searchProjectFiles } from "./fs-service";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitGenerateMessage,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  gitUnstageAll,
} from "./git-service";
import { createHtmlPreviewUrl } from "./html-preview-protocol";
import {
  getAuthPath,
  getConfigYmlPath,
  getDiagnostics,
  getModelsPath,
  getSettingsPath,
  readModelsFile,
  readModelRoles,
  readThinking,
  testModelAvailability,
  writeModelRole,
  writeModelsProviders,
  writeThinking,
} from "./models-service";
import { PiBridge, getOmpVersion, isAppManagedRuntime, resetPiRuntime, resolvePiRuntime, runtimeKind } from "./pi-bridge";
import { getOmpConfig, resetOmpConfigKey, setOmpConfigKey } from "./omp-config";
import { createGateModeFile, ensureGateExtension, removeGateModeFile, writeGateMode } from "./permission-gate";
import { initDesktopNotify, maybeDesktopNotify, setActiveNotifyThread, threadNotifyLabel } from "./notify";
import { readPreview } from "./preview-service";
import { deleteProjectSessions, getAgentDir, getTotalUsage, type ProjectSummary, readThreadHistory, scanProjects, searchThreads, type ThreadSearchHit } from "./session-store";
import { listMcpServers, probeMcpServers, removeMcpServer, saveMcpServer, setMcpLists, setMcpServerEnabled, type McpServerConfig } from "./mcp";
import {
  isLocalExtensionSource,
  listPackages,
  listSkills,
  probeOmpStartup,
  removePackageEntry,
  runOmpCli,
  setPackageEnabled,
  setSkillEnabled,
} from "./plugins";
import { runTaskNow, startScheduler } from "./automation";

type PermissionLevel = "sandbox" | "full";

/**
 * Wires the renderer's window.pi.* calls to main-process services and to the
 * per-thread pi RPC bridges. Agent events and extension-UI requests are pushed
 * back to the renderer as `pi:event` / `pi:extui` / `pi:exit` / `pi:error`.
 *
 * The bridge registry stores the *handle* (not just the bridge) so that when a
 * session file path changes (new session / fork) we can re-key the map AND the
 * closure id used for event routing in one step.
 */

interface BridgeHandle {
  bridge: PiBridge;
  getId: () => string;
  setId: (n: string) => void;
  permission: PermissionLevel;
  gateModeFile: string;
  /** Cached session title for desktop-notify body (multi-tab discrimination). */
  sessionLabel?: string;
}

const bridges = new Map<string, BridgeHandle>();

const IMG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const TEXT_ATTACH_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
  ".csv", ".tsv", ".log", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".css",
  ".scss", ".html", ".htm", ".py", ".go", ".rs", ".java", ".sh", ".bash", ".sql",
  ".env", ".ini", ".cfg", ".conf", ".vue", ".svelte",
]);

interface Attachment {
  abs: string;
  name: string;
}

function processAttachments(attachments: Attachment[] | undefined, text: string): { text: string; images: unknown[] } {
  const images: unknown[] = [];
  let extra = "";
  if (attachments && attachments.length) {
    for (const a of attachments) {
      const ext = extname(a.name || a.abs).toLowerCase();
      try {
        if (ext in IMG_MIME) {
          const buf = readFileSync(a.abs);
          images.push({ type: "image", data: buf.toString("base64"), mimeType: IMG_MIME[ext] });
          continue;
        }
        if (TEXT_ATTACH_EXTS.has(ext) || ext === "") {
          const st = statSync(a.abs);
          if (st.size <= 500_000) {
            const content = readFileSync(a.abs, "utf8");
            extra += `\n\n<file name="${a.name}">\n${content}\n</file>`;
            continue;
          }
        }
        extra += `\n\n<file name="${a.name}" path="${a.abs}" note="attached (binary or large; not inlined)" />`;
      } catch (e: any) {
        extra += `\n\n<file name="${a.name}" error="${e?.message || "read failed"}" />`;
      }
    }
  }
  return { text: text + extra, images };
}

function createHandle(
  cwd: string,
  sessionFile: string | undefined,
  permission: PermissionLevel,
  send: (ch: string, p: unknown) => void,
): BridgeHandle {
  let id = sessionFile || `boot:${randomUUID()}`;
  const gateModeFile = createGateModeFile(getConfigDir(), permission);
  const handle: BridgeHandle = {
    bridge: null as unknown as PiBridge,
    getId: () => id,
    setId: (n: string) => {
      if (n && n !== id) {
        bridges.delete(id);
        id = n;
        bridges.set(n, handle);
      }
    },
    permission,
    gateModeFile,
  };
  handle.bridge = new PiBridge({
    cwd,
    ompBinPath: getConfig().ompBinPath,
    sessionFile,
    // The gate extension is always loaded; its sandbox/full behaviour is decided
    // at runtime by the per-thread mode file, so permission can change live.
    extensions: [ensureGateExtension(getConfigDir())],
    gateModeFile,
    onEvent: (e) => {
      send("pi:event", { threadId: id, event: e });
      const ev = e as { type?: string } | null;
      if (ev?.type === "agent_settled") {
        const zh = getConfig().language === "zh";
        const fire = (label: string) =>
          maybeDesktopNotify({
            kind: "idle",
            title: zh ? "Agent 已完成" : "Agent finished",
            body: zh ? `${label} 的回复已就绪` : `${label} is ready for your review`,
            threadId: id,
            cwd,
          });
        // Refresh session title so multi-tab notifications stay distinguishable.
        handle.bridge
          .getState()
          .then((state: any) => {
            if (typeof state?.sessionName === "string" && state.sessionName.trim()) {
              handle.sessionLabel = state.sessionName.trim();
            }
            fire(threadNotifyLabel(cwd, handle.sessionLabel));
          })
          .catch(() => fire(threadNotifyLabel(cwd, handle.sessionLabel)));
      }
    },
    onExtUi: (r) => {
      send("pi:extui", { threadId: id, request: r });
      if (r?.method === "confirm" || r?.method === "select") {
        const zh = getConfig().language === "zh";
        const label = threadNotifyLabel(cwd, handle.sessionLabel);
        const detail = String(r.title || r.message || (zh ? "Sandbox 等待授权" : "Sandbox is waiting for approval"));
        maybeDesktopNotify({
          kind: "approval",
          title: zh ? `需要确认 · ${label}` : `Action required · ${label}`,
          body: detail.slice(0, 180),
          threadId: id,
          cwd,
        });
      }
    },
    onExit: (info) => {
      // Only forget the bridge if it is still the one registered under this id
      // (a delayed exit must not evict a bridge that replaced it).
      if (bridges.get(id) === handle) bridges.delete(id);
      if (warmHandle === handle) {
        warmHandle = null;
        if (!info.expected) warmFailures++;
        // eslint-disable-next-line no-console
        console.log(`[omp] warm spare exited (code=${info.code}, expected=${!!info.expected}, failures=${warmFailures})`);
        // Refill unless the spare keeps dying (avoid a crash loop).
        if (warmFailures < 3) setTimeout(() => ensureWarmBridge(), 500);
      }
      removeGateModeFile(gateModeFile);
      // An intentional stop (thread close / app quit) is expected and must not
      // surface as a "pi process exited" error.
      if (!info.expected) {
        send("pi:exit", { threadId: id, ...info });
        // Warm-spare exits use boot:* ids; don't spam desktop notifications for them.
        if (!id.startsWith("boot:")) {
          const zh = getConfig().language === "zh";
          maybeDesktopNotify({
            kind: "error",
            title: zh ? "omp 进程异常退出" : "omp process exited",
            body: `${threadNotifyLabel(cwd, handle.sessionLabel)} (code ${info.code})`,
            threadId: id,
            cwd,
          });
        }
      }
    },
    onError: (err) => {
      send("pi:error", { threadId: id, message: err.message });
      if (!id.startsWith("boot:")) {
        const zh = getConfig().language === "zh";
        maybeDesktopNotify({
          kind: "error",
          title: zh ? "Agent 出错" : "Agent error",
          body: `${threadNotifyLabel(cwd, handle.sessionLabel)}: ${err.message}`.slice(0, 180),
          threadId: id,
          cwd,
        });
      }
    },
  });
  return handle;
}

/* ------------------------------------------------------------------ *
 * Warm spare bridge
 * ------------------------------------------------------------------ *
 * pi's cold start takes ~5s on Windows: its ESM module graph is thousands
 * of small files and Windows Defender's real-time filter scans each open
 * synchronously (measured: 3.5s wall time with <100ms CPU — pure I/O wait).
 * Every thread open used to spawn a fresh process and block on it, so
 * clicks appeared dead for 5 seconds.
 *
 * Fix: keep exactly ONE fully-booted pi process on standby. thread:open
 * adopts it when the cwd matches (switching sessions on a warm process
 * measures ~0.5s vs ~5s cold) and refills the spare in the background.
 * Cost: one idle node process (~190MB); it is stopped on app quit.
 */
let warmHandle: BridgeHandle | null = null;
let lastOpenCwd: string | null = null;
let warmFailures = 0;
let warmEnabled = false;
let sendToRenderer: ((ch: string, p: unknown) => void) | null = null;

function warmCwd(): string {
  // Prefer the project actually used most recently (persisted), so the first
  // click after an app restart already hits a matching spare.
  return lastOpenCwd || getConfig().lastThreadCwd || (getConfig().pinnedProjects || [])[0] || homedir();
}

/**
 * Directory identity across sources. On Windows the same folder arrives in
 * different spellings depending on who produced it — the folder dialog,
 * pinned config, and the cwd pi recorded inside a session file can differ in
 * drive-letter case and slash direction. Compare normalized, or the warm
 * spare would never match and every open would fall back to a cold start.
 */
function sameDir(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (process.platform === "win32") {
    const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/[\\/]+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  return norm(a) === norm(b);
}

/** Spawn the standby process if there is none. Safe to call anytime. */
export function ensureWarmBridge(): void {
  if (!warmEnabled || warmHandle || !sendToRenderer) return;
  if (warmFailures >= 3) return; // repeated crashes: stop respawning
  const cwd = warmCwd();
  const handle = createHandle(cwd, undefined, "sandbox", sendToRenderer);
  warmHandle = handle;
  // eslint-disable-next-line no-console
  console.log("[omp] warm spare spawning (cwd=" + cwd + ")");
  handle.bridge
    .start()
    .then(() => handle.bridge.getState()) // wait until pi answers: fully booted
    .then(() => {
      if (warmHandle === handle) {
        // eslint-disable-next-line no-console
        console.log("[omp] warm spare ready — thread opens are now fast");
      }
    })
    .catch((err) => {
      if (warmHandle === handle) warmHandle = null;
      // A spawned-but-dead process is counted by its onExit handler; only
      // count spawn-time failures here to avoid double counting.
      if (!handle.bridge.running) warmFailures++;
      // eslint-disable-next-line no-console
      console.error("[omp] warm bridge failed to start:", (err as Error)?.message || String(err));
    });
}

/** Kill the standby process (runtime changed, quitting, etc.). */
export function dropWarmBridge(): void {
  if (warmHandle) {
    warmHandle.bridge.stop();
    warmHandle = null;
  }
}

/**
 * Config.yml is read at omp process boot, so a burst of config edits must
 * recreate the standby once (trailing), not once per key (~5s spawn each).
 */
let warmRecreateTimer: NodeJS.Timeout | null = null;
function scheduleWarmRecreate(): void {
  if (warmRecreateTimer) clearTimeout(warmRecreateTimer);
  warmRecreateTimer = setTimeout(() => {
    warmRecreateTimer = null;
    dropWarmBridge();
    ensureWarmBridge();
  }, 2000);
}

async function gatherThread(bridge: PiBridge, threadId: string, permission: PermissionLevel, handle?: BridgeHandle) {
  const state: any = await bridge.getState();
  const [msgRes, modelsRes, cmdsRes, branchRes]: any[] = await Promise.all([
    bridge.getMessages(),
    bridge.getAvailableModels(),
    bridge.getCommands().catch(() => ({ commands: [] })),
    bridge.getBranchMessages().catch(() => ({ messages: [] })),
  ]);
  if (handle && typeof state?.sessionName === "string" && state.sessionName.trim()) {
    handle.sessionLabel = state.sessionName.trim();
  }
  return {
    threadId,
    cwd: bridge.cwd,
    sessionFile: state.sessionFile ?? null,
    sessionName: state.sessionName ?? null,
    model: state.model ?? null,
    thinkingLevel: state.thinkingLevel ?? "off",
    isStreaming: !!state.isStreaming,
    messages: msgRes?.messages ?? [],
    branchMessages: branchRes?.messages ?? [],
    models: modelsRes?.models ?? [],
    commands: cmdsRes?.commands ?? [],
    permission,
  };
}

/** Resolve the effective permission level for a thread open request. */
function resolvePermission(sessionFile: string | undefined, requested: PermissionLevel | undefined): PermissionLevel {
  if (requested === "sandbox" || requested === "full") return requested;
  if (sessionFile) {
    const stored = getConfig().threadPermissions[sessionFile];
    if (stored === "sandbox" || stored === "full") return stored;
  }
  return "sandbox"; // default
}

export function stopAllBridges(): void {
  warmEnabled = false; // no respawns while shutting down
  for (const h of bridges.values()) h.bridge.stop();
  bridges.clear();
  dropWarmBridge();
}

export function registerIpc(getWin: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  sendToRenderer = send;
  warmEnabled = true;
  initDesktopNotify(getWin, (threadId, cwd) => send("pi:notify-activate", { threadId, cwd }));

  // ---- app / config -------------------------------------------------------
  ipcMain.handle("app:getVersion", () => app.getVersion());
  ipcMain.handle("app:getConfig", () => getConfig());
  ipcMain.handle("app:setActiveThread", (_e, threadId: string | null) => {
    setActiveNotifyThread(typeof threadId === "string" ? threadId : null);
    return true;
  });
  ipcMain.handle("app:setConfig", (_e, patch) => {
    const prev = getConfig().ompBinPath;
    const next = updateConfig(patch || {});
    if ((next.ompBinPath || "") !== (prev || "")) {
      resetPiRuntime();
      dropWarmBridge(); // standby was booted from the old runtime
      ensureWarmBridge();
    }
    return next;
  });
  ipcMain.handle("app:resolveRuntime", async () => {
    try {
      const rt = await resolvePiRuntime(getConfig().ompBinPath);
      const version = await getOmpVersion(rt.bin);
      // eslint-disable-next-line no-console
      console.log("[omp] runtime resolved ->", "bin:", rt.bin);
      return { ok: true, bin: rt.bin, version };
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[omp] runtime resolve failed:", e?.message || String(e));
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // ---- projects / sessions ------------------------------------------------
  ipcMain.handle("app:getProjects", async (): Promise<ProjectSummary[]> => {
    const scanned = await scanProjects();
    const pinned = getConfig().pinnedProjects || [];
    const archived = new Set((getConfig().archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const archivedThreads = new Set((getConfig().archivedThreads || []).map((thread) => thread.file.toLowerCase()));
    const visibleScanned = scanned
      .filter((project) => !archived.has(project.cwd.toLowerCase()))
      .map((project) => ({
        ...project,
        threads: project.threads.filter((thread) => !archivedThreads.has(thread.file.toLowerCase())),
      }));
    const visiblePinned = pinned.filter((cwd) => !archived.has(cwd.toLowerCase()));
    const byCwd = new Map(visibleScanned.map((p) => [p.cwd, p]));
    const result: ProjectSummary[] = [];
    for (const cwd of visiblePinned) {
      const existing = byCwd.get(cwd);
      if (existing) result.push(existing);
      else result.push({ cwd, name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd, threads: [] });
    }
    for (const p of visibleScanned) if (!visiblePinned.includes(p.cwd)) result.push(p);
    return result;
  });

  ipcMain.handle("app:searchThreads", async (_e, query: string): Promise<ThreadSearchHit[]> => {
    const archived = new Set((getConfig().archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const archivedThreads = new Set((getConfig().archivedThreads || []).map((thread) => thread.file.toLowerCase()));
    return (await searchThreads(query)).filter(
      (hit) => !archived.has(hit.cwd.toLowerCase()) && !archivedThreads.has(hit.file.toLowerCase()),
    );
  });

  ipcMain.handle("app:getTotalUsage", () => getTotalUsage());

  // Current git branch of a thread's working directory (worktree-aware:
  // `branch --show-current` reports the branch checked out in that worktree).
  ipcMain.handle("app:getGitBranch", (_e, cwd: string) => {
    return new Promise<string | null>((resolve) => {
      if (!cwd || typeof cwd !== "string") return resolve(null);
      execFile("git", ["-C", cwd, "branch", "--show-current"], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  });

  // Worktree relationship: commonDir identifies the repo shared by all its
  // worktrees; a linked worktree's own git-dir lives under
  // `<commonDir>/worktrees/<name>` while the main checkout's equals commonDir.
  ipcMain.handle("app:getGitInfo", (_e, cwd: string) => {
    return new Promise<{ branch: string | null; commonDir: string | null; isLinked: boolean }>((resolve) => {
      const empty = { branch: null, commonDir: null, isLinked: false };
      if (!cwd || typeof cwd !== "string") return resolve(empty);
      execFile(
        "git",
        ["-C", cwd, "rev-parse", "--git-common-dir", "--git-dir", "--abbrev-ref", "HEAD"],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(empty);
          const [commonRaw, dirRaw, branchRaw] = stdout.trim().split(/\r?\n/);
          if (!commonRaw || !dirRaw) return resolve(empty);
          const abs = (p: string) => {
            try {
              return realpathSync(isAbsolute(p) ? p : join(cwd, p));
            } catch {
              return null;
            }
          };
          const commonDir = abs(commonRaw);
          const gitDir = abs(dirRaw);
          if (!commonDir || !gitDir) return resolve(empty);
          const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
          resolve({ branch, commonDir, isLinked: gitDir !== commonDir });
        },
      );
    });
  });

  // Git panel operations (sidebar Git tab). Status/log degrade to empty
  // shapes; mutations return { ok, error } with git's own message for toasts.
  ipcMain.handle("git:status", (_e, cwd: string) => gitStatus(cwd));
  ipcMain.handle("git:branches", (_e, cwd: string) => gitBranches(cwd));
  ipcMain.handle("git:log", (_e, cwd: string, limit?: number) => gitLog(cwd, limit));
  ipcMain.handle("git:stage", (_e, args: { cwd: string; paths: string[] }) => gitStage(args.cwd, args.paths || []));
  ipcMain.handle("git:unstage", (_e, args: { cwd: string; paths: string[] }) => gitUnstage(args.cwd, args.paths || []));
  ipcMain.handle("git:stageAll", (_e, cwd: string) => gitStageAll(cwd));
  ipcMain.handle("git:unstageAll", (_e, cwd: string) => gitUnstageAll(cwd));
  ipcMain.handle("git:discard", (_e, args: { cwd: string; tracked: string[]; untracked: string[] }) =>
    gitDiscard(args.cwd, args.tracked || [], args.untracked || []),
  );
  ipcMain.handle("git:commit", (_e, args: { cwd: string; message: string }) => gitCommit(args.cwd, args.message));
  ipcMain.handle("git:generateMessage", (_e, cwd: string) => gitGenerateMessage(cwd));
  ipcMain.handle("git:checkout", (_e, args: { cwd: string; branch: string }) => gitCheckout(args.cwd, args.branch));
  ipcMain.handle("git:pull", (_e, cwd: string) => gitPull(cwd));
  ipcMain.handle("git:push", (_e, cwd: string) => gitPush(cwd));

  ipcMain.handle("app:openProject", async (_e, absPath: string) => {
    if (!absPath || !existsSync(absPath) || !statSync(absPath).isDirectory()) {
      throw new Error("Not a directory: " + absPath);
    }
    const cfg = getConfig();
    const pinned = cfg.pinnedProjects || [];
    if (!pinned.includes(absPath)) updateConfig({ pinnedProjects: [absPath, ...pinned] });
    return { cwd: absPath, name: absPath.split(/[\\/]/).filter(Boolean).pop() || absPath };
  });

  ipcMain.handle("app:unpinProject", (_e, absPath: string) => {
    const cfg = getConfig();
    updateConfig({ pinnedProjects: (cfg.pinnedProjects || []).filter((p) => p !== absPath) });
    return true;
  });

  // Permanently delete an archived project's session files and forget it.
  ipcMain.handle("app:deleteProject", async (_e, cwd: string) => {
    if (!cwd || typeof cwd !== "string") return { ok: false, error: "Invalid path" };
    const removed = await deleteProjectSessions(cwd);
    const cfg = getConfig();
    const key = cwd.toLowerCase();
    updateConfig({
      archivedProjects: (cfg.archivedProjects || []).filter((p) => p.toLowerCase() !== key),
      archivedThreads: (cfg.archivedThreads || []).filter((t) => t.cwd.toLowerCase() !== key),
    });
    return { ok: true, removed };
  });

  // Pre-warm the standby pi process for the project the user is looking at, so
  // a subsequent "new task" adopts an already-booted process (~0.5s) instead of
  // cold-starting (~5s). Re-targets the spare when the active project changes.
  ipcMain.handle("app:prewarm", (_e, cwd: string) => {
    if (!cwd || typeof cwd !== "string") return { ok: false };
    lastOpenCwd = cwd;
    if (warmHandle && !sameDir(warmHandle.bridge.cwd, cwd)) dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });

  ipcMain.handle("app:showOpenDialog", async (_e, kind: "folder" | "file" | "files") => {
    const w = getWin();
    const properties: any[] =
      kind === "folder"
        ? ["openDirectory", "createDirectory"]
        : kind === "files"
          ? ["openFile", "multiSelections"]
          : ["openFile"];
    const res = await dialog.showOpenDialog(w!, { properties, title: kind === "folder" ? "Open project folder" : "Attach files" });
    if (res.canceled) return null;
    return kind === "folder" ? res.filePaths[0] : res.filePaths;
  });

  // ---- files / preview ----------------------------------------------------
  ipcMain.handle("app:getFileTree", (_e, cwd: string, rel?: string) => listDir(cwd, rel));
  ipcMain.handle("app:searchProjectFiles", (_e, cwd: string, query: string, limit?: number) =>
    searchProjectFiles(cwd, query, limit),
  );
  ipcMain.handle("app:fileExists", (_e, absPath: string) => {
    try {
      return !!absPath && statSync(absPath).isFile();
    } catch {
      return false;
    }
  });
  ipcMain.handle("app:readPreview", (_e, absPath: string, projectRoot?: string) => {
    const payload = readPreview(absPath);
    return payload.kind === "html"
      ? { ...payload, previewUrl: createHtmlPreviewUrl(absPath, projectRoot) }
      : payload;
  });
  ipcMain.handle("app:showFileContextMenu", (event, absPath: string) => {
    if (!absPath || !existsSync(absPath)) return { ok: false, error: "File not found" };
    const language = getConfig().language;
    const menu = Menu.buildFromTemplate([
      {
        label: language === "zh" ? "在资源管理器中显示" : "Show in File Explorer",
        click: () => shell.showItemInFolder(absPath),
      },
      {
        label: language === "zh" ? "使用默认应用打开" : "Open with Default App",
        click: () => void shell.openPath(absPath),
      },
    ]);
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || undefined });
    return { ok: true };
  });

  // ---- settings: models.json / settings.json / diagnostics ----------------
  ipcMain.handle("settings:getModels", () => readModelsFile());
  ipcMain.handle("settings:getLiveProviders", async () => {
    // omp's live registry: the providers it can actually authenticate right
    // now. The models tab shows these read-only so built-in providers no
    // longer look like empty custom configs. Prefer an already-running
    // process; probe with a throwaway one before any thread exists.
    const running = [...bridges.values()].find((h) => h.bridge.running) || (warmHandle?.bridge.running ? warmHandle : null);
    if (running) return running.bridge.getAvailableModels();
    const probe = new PiBridge({ cwd: warmCwd(), onEvent: () => {}, onExtUi: () => {}, onExit: () => {} });
    try {
      await probe.start();
      return await probe.getAvailableModels();
    } catch {
      return { models: [] };
    } finally {
      probe.stop();
    }
  });
  ipcMain.handle(
    "settings:testModel",
    (_e, args: { providerId: string; provider: Record<string, unknown>; modelId: string }) =>
      testModelAvailability(args.providerId, args.provider as any, args.modelId),
  );
  ipcMain.handle("settings:saveModels", (_e, providers: Record<string, unknown>) => {
    writeModelsProviders(providers as any);
    // The standby process also caches its model registry. Recreate it now so a
    // new task opened after saving does not adopt a stale pre-save process.
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  ipcMain.handle("settings:getThinking", () => readThinking());
  ipcMain.handle("settings:saveThinking", (_e, patch: Record<string, unknown>) => {
    const next = writeThinking(patch as any);
    // defaultThinkingLevel is read at process boot; the standby is stale now.
    dropWarmBridge();
    ensureWarmBridge();
    return next;
  });
  ipcMain.handle("settings:getModelRoles", () => readModelRoles());
  ipcMain.handle("settings:setModelRole", (_e, role: string, provider: string, model: string | null, level?: string | null) => {
    const next = writeModelRole(role, provider, model, level);
    // Role models resolve at process boot; the standby spare still carries
    // the previous routing. Recreate it (same as settings:saveModels).
    dropWarmBridge();
    ensureWarmBridge();
    return next;
  });
  ipcMain.handle("settings:getDiagnostics", () => getDiagnostics());
  ipcMain.handle("settings:openPath", async (_e, abs: string) => {
    try {
      const err = await shell.openPath(abs);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:showItem", (_e, abs: string) => {
    try {
      shell.showItemInFolder(abs);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:openAgentDir", async () => {
    const err = await shell.openPath(getAgentDir());
    return err ? { ok: false, error: err } : { ok: true };
  });
  // expose resolved paths so the renderer can label buttons without guessing
  ipcMain.handle("settings:getPaths", () => ({
    agentDir: getAgentDir(),
    models: getModelsPath(),
    settings: getSettingsPath(),
    auth: getAuthPath(),
    config: getConfigYmlPath(),
  }));

  // ---- omp config.yml (schema-driven editor) ------------------------------
  ipcMain.handle("settings:getOmpConfig", () => getOmpConfig());
  ipcMain.handle("settings:setOmpConfigKey", async (_e, key: string, value: unknown, type: string) => {
    await setOmpConfigKey(key, value, type);
    scheduleWarmRecreate();
    return { ok: true };
  });
  ipcMain.handle("settings:resetOmpConfigKey", async (_e, key: string) => {
    await resetOmpConfigKey(key);
    scheduleWarmRecreate();
    return { ok: true };
  });

  // ---- threads (pi bridges) ----------------------------------------------
  /**
   * Instant thread load for the UI. Reading the transcript from the .jsonl on
   * disk takes milliseconds, so a clicked thread renders immediately instead of
   * waiting ~5s for a pi process to boot. When a live bridge already backs the
   * session we return its live state instead (connected:true); otherwise we
   * return disk data with connected:false and the renderer connects lazily/in
   * the background via thread:open.
   */
  ipcMain.handle("thread:loadHistory", async (_e, args: { cwd: string; sessionFile: string }) => {
    const { cwd, sessionFile } = args;
    const permission = resolvePermission(sessionFile, undefined);
    const existing = bridges.get(sessionFile);
    if (existing) return { connected: true, ...(await gatherThread(existing.bridge, sessionFile, existing.permission, existing)) };
    const hist = await readThreadHistory(sessionFile);
    return {
      connected: false,
      threadId: sessionFile,
      cwd: hist.cwd || cwd,
      sessionFile,
      sessionName: hist.sessionName,
      model: hist.model,
      thinkingLevel: hist.thinkingLevel || "off",
      isStreaming: false,
      messages: hist.messages,
      branchMessages: hist.branchMessages,
      models: [],
      commands: [],
      permission,
    };
  });

  ipcMain.handle("thread:open", async (_e, args: { cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel }) => {
    const { cwd, sessionFile, name } = args;
    if (sessionFile && bridges.has(sessionFile)) {
      const existing = bridges.get(sessionFile)!;
      return gatherThread(existing.bridge, sessionFile, existing.permission, existing);
    }
    lastOpenCwd = cwd;
    if ((getConfig().lastThreadCwd || "") !== cwd) updateConfig({ lastThreadCwd: cwd });
    const permission = resolvePermission(sessionFile, args.permission);
    let handle: BridgeHandle | null = null;
    let adopted = false;
    const spareAtEntry = !!warmHandle;
    // Try to adopt the warm spare: switching a booted process is ~0.5s vs
    // ~5s for a cold start. A dead spare is dropped, a spare booted for
    // another project is replaced so the standby converges on the project
    // actually in use.
    if (!name && warmHandle) {
      if (!warmHandle.bridge.running) {
        // eslint-disable-next-line no-console
        console.log("[omp] thread:open dropping dead warm spare -> cold start");
        dropWarmBridge();
      } else if (!sameDir(warmHandle.bridge.cwd, cwd)) {
        // eslint-disable-next-line no-console
        console.log(`[omp] thread:open cwd mismatch (warm="${warmHandle.bridge.cwd}" requested="${cwd}") -> cold start, spare respawns for new cwd`);
        dropWarmBridge();
      } else {
        handle = warmHandle;
        warmHandle = null;
        adopted = true;
        warmFailures = 0;
        handle.permission = permission;
        writeGateMode(handle.gateModeFile, permission);
        // eslint-disable-next-line no-console
        console.log("[omp] thread:open adopting warm spare" + (sessionFile ? " (switch_session)" : " (fresh)"));
      }
    }
    if (!handle) {
      if (!spareAtEntry && !name) {
        // eslint-disable-next-line no-console
        console.log("[omp] thread:open cold start (no spare available yet)");
      }
      handle = createHandle(cwd, sessionFile, permission, send);
    }
    bridges.set(handle.getId(), handle);
    try {
      await handle.bridge.start(); // no-op for the already-running spare
      if (adopted && sessionFile) {
        await handle.bridge.switchSession(sessionFile);
      }
      const state: any = await handle.bridge.getState();
      const finalId = state.sessionFile || handle.getId();
      handle.setId(finalId);
      // Persist the chosen level keyed by the real session file so reopening resumes it.
      if (state.sessionFile) {
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== permission) updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: permission } });
      }
      return gatherThread(handle.bridge, finalId, permission, handle);
    } catch (e) {
      bridges.delete(handle.getId());
      removeGateModeFile(handle.gateModeFile);
      handle.bridge.stop();
      throw e;
    } finally {
      ensureWarmBridge(); // keep exactly one spare booted for the next open
    }
  });

  ipcMain.handle("thread:setPermission", async (_e, args: { threadId: string; permission: PermissionLevel }) => {
    const perms = getConfig().threadPermissions;
    updateConfig({ threadPermissions: { ...perms, [args.threadId]: args.permission } });
    // Flip the running thread's gate mode live; the pi process keeps running.
    const h = bridges.get(args.threadId);
    if (h) {
      h.permission = args.permission;
      writeGateMode(h.gateModeFile, args.permission);
    }
    return { ok: true };
  });

  ipcMain.handle("thread:close", (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (h) {
      h.bridge.stop();
      bridges.delete(threadId);
    }
    return true;
  });

  ipcMain.handle("thread:prompt", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.prompt(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:steer", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.steer(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:followUp", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.followUp(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:abort", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (h) await h.bridge.abort();
    return true;
  });

  ipcMain.handle("thread:setModel", async (_e, args: { threadId: string; provider: string; modelId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const model = await h.bridge.setModel(args.provider, args.modelId);
    // Pi clamps the current thinking level when the selected model exposes a
    // narrower thinkingLevelMap. Return the effective value so the renderer's
    // badge stays in sync with the live session instead of showing stale max.
    const state: any = await h.bridge.getState();
    return { model, thinkingLevel: state?.thinkingLevel ?? null };
  });

  ipcMain.handle("thread:getModels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { models: [] };
    return h.bridge.getAvailableModels();
  });

  ipcMain.handle("thread:refreshModels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { models: [] };
    return h.bridge.refreshModels();
  });

  ipcMain.handle("thread:setThinking", async (_e, args: { threadId: string; level: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    await h.bridge.setThinkingLevel(args.level);
    const state: any = await h.bridge.getState();
    return { thinkingLevel: state?.thinkingLevel ?? args.level };
  });

  ipcMain.handle("thread:getThinkingLevels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { levels: ["off"] };
    return h.bridge.getAvailableThinkingLevels();
  });

  ipcMain.handle("thread:newSession", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) throw new Error("Thread not open");
    const res: any = await h.bridge.newSession();
    if (res?.cancelled) return { cancelled: true };
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || threadId;
    h.setId(newId);
    return { cancelled: false, ...(await gatherThread(h.bridge, newId, h.permission, h)) };
  });

  ipcMain.handle("thread:getBranchMessages", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { messages: [] };
    const res = await h.bridge.getBranchMessages();
    return { messages: res?.messages ?? [] };
  });

  const finishBranch = async (h: BridgeHandle, oldId: string, selectedText?: string) => {
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || oldId;
    h.setId(newId);
    const perms = getConfig().threadPermissions;
    if (state.sessionFile && perms[state.sessionFile] !== h.permission) {
      updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: h.permission } });
    }
    return { ...(await gatherThread(h.bridge, newId, h.permission, h)), selectedText };
  };

  ipcMain.handle("thread:fork", async (_e, args: { threadId: string; entryId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const previousFile = (await h.bridge.getState() as any)?.sessionFile;
    await h.bridge.branchAt(args.entryId);
    const currentFile = (await h.bridge.getState() as any)?.sessionFile;
    if (!currentFile || currentFile === previousFile) throw new Error("Fork did not create a new session");
    return { cancelled: false, ...(await finishBranch(h, args.threadId)) };
  });

  ipcMain.handle("thread:clone", async (_e, args: { threadId: string; entryId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const previousFile = (await h.bridge.getState() as any)?.sessionFile;
    await h.bridge.branchAt(args.entryId);
    const currentFile = (await h.bridge.getState() as any)?.sessionFile;
    if (!currentFile || currentFile === previousFile) throw new Error("Clone did not create a new session");
    return { cancelled: false, ...(await finishBranch(h, args.threadId)) };
  });

  ipcMain.handle("thread:setName", async (_e, args: { threadId: string; name: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const res = await h.bridge.setSessionName(args.name);
    if (typeof args.name === "string" && args.name.trim()) h.sessionLabel = args.name.trim();
    return res;
  });

  ipcMain.handle("thread:getStats", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return null;
    return h.bridge.getSessionStats();
  });

  ipcMain.handle("thread:getCommands", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { commands: [] };
    return h.bridge.getCommands();
  });

  ipcMain.handle("thread:extuiResponse", (_e, args: { threadId: string; id: string; payload: Record<string, unknown> }) => {
    const h = bridges.get(args.threadId);
    if (h) h.bridge.respondExtUi(args.id, args.payload || {});
    return true;
  });

  // ---- plugins (pi packages + standalone skills) -------------------------
  ipcMain.handle("plugins:getPackages", () => listPackages());
  ipcMain.handle("plugins:setPackageEnabled", async (_e, args: { source: string; enabled: boolean }) => {
    await setPackageEnabled(args.source, args.enabled);
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  ipcMain.handle("plugins:installPackage", async (_e, source: string) => {
    const res = await runOmpCli(["plugin", "install", source]);
    const installOutput = (res.stdout + res.stderr).trim();
    if (res.code !== 0) {
      // Never keep a failed install visible as healthy: surface the output.
      return { ok: false, output: installOutput || `omp plugin install exited with code ${res.code}` };
    }
    const probe = await probeOmpStartup();
    if (!probe.ok) {
      dropWarmBridge();
      ensureWarmBridge();
      return {
        ok: false,
        output: [installOutput, "Installed, but omp could not load the extension. Check its output below.", probe.output]
          .filter(Boolean)
          .join("\n"),
      };
    }
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, output: installOutput };
  });
  ipcMain.handle("plugins:removePackage", async (_e, source: string) => {
    if (isLocalExtensionSource(source)) {
      removePackageEntry(source);
      dropWarmBridge();
      ensureWarmBridge();
      return { ok: true, output: "" };
    }
    const res = await runOmpCli(["plugin", "uninstall", source]);
    dropWarmBridge();
    ensureWarmBridge();
    return {
      ok: res.code === 0,
      output: (res.stdout + res.stderr).trim() || (res.code === 0 ? "" : `omp plugin uninstall exited with code ${res.code}`),
    };
  });
  ipcMain.handle("plugins:getSkills", (_e, cwd?: string) => listSkills(typeof cwd === "string" ? cwd : undefined));
  ipcMain.handle("plugins:setSkillEnabled", (_e, args: { path: string; enabled: boolean }) => {
    setSkillEnabled(args.path, args.enabled);
    // A skill is loaded during pi startup. Recreate the warm spare so newly
    // opened tasks immediately observe enable/disable changes.
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  // Update installed extension packages. With no source, updates all of them
  // (`omp plugin upgrade`); with a source, updates just that package.
  ipcMain.handle("plugins:updatePackages", async (_e, source?: string) => {
    const args = source ? ["plugin", "upgrade", source] : ["plugin", "upgrade"];
    const res = await runOmpCli(args);
    if (res.code === 0) {
      dropWarmBridge();
      ensureWarmBridge();
    }
    return { ok: res.code === 0, code: res.code, output: (res.stdout + res.stderr).trim() };
  });

  // ---- mcp servers (mcp.json) --------------------------------------------
  ipcMain.handle("mcp:getServers", () => listMcpServers());
  ipcMain.handle("mcp:probeServers", () => probeMcpServers());
  ipcMain.handle("mcp:saveServer", async (_e, args: { name: string; config: McpServerConfig }) => {
    await saveMcpServer(args.name, args.config);
    // MCP servers connect during omp startup; recreate the spare so newly
    // opened tasks immediately observe config changes.
    dropWarmBridge();
    ensureWarmBridge();
    return probeMcpServers();
  });
  ipcMain.handle("mcp:removeServer", async (_e, name: string) => {
    await removeMcpServer(name);
    dropWarmBridge();
    ensureWarmBridge();
    return probeMcpServers();
  });
  ipcMain.handle("mcp:setServerEnabled", async (_e, args: { name: string; enabled: boolean }) => {
    await setMcpServerEnabled(args.name, args.enabled);
    dropWarmBridge();
    ensureWarmBridge();
    return probeMcpServers();
  });
  ipcMain.handle("mcp:setLists", async (_e, args: { disabledServers: string[]; enabledServers: string[] }) => {
    await setMcpLists(args.disabledServers, args.enabledServers);
    dropWarmBridge();
    ensureWarmBridge();
    return probeMcpServers();
  });

  // ---- automation (scheduled tasks) --------------------------------------
  ipcMain.handle("automation:getTasks", () => getConfig().automationTasks);
  ipcMain.handle("automation:saveTask", (_e, task: AutomationTask) => {
    const tasks = getConfig().automationTasks;
    const idx = tasks.findIndex((t) => t.id === task.id);
    const next = idx >= 0 ? tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t)) : [...tasks, task];
    updateConfig({ automationTasks: next });
    return { ok: true };
  });
  ipcMain.handle("automation:deleteTask", (_e, id: string) => {
    updateConfig({ automationTasks: getConfig().automationTasks.filter((t) => t.id !== id) });
    return { ok: true };
  });
  ipcMain.handle("automation:runNow", async (_e, id: string) => {
    await runTaskNow(id);
    return { ok: true };
  });

  // ---- update pi core -----------------------------------------------------
  ipcMain.handle("app:checkAppUpdate", () => checkForAppUpdate());
  ipcMain.handle("app:downloadAppUpdate", async () => downloadAppUpdate((p) => send("pi:appUpdate", p)));
  ipcMain.handle("app:installAppUpdate", () => installAppUpdate());
  ipcMain.handle("app:deferAppUpdate", () => deferAppUpdate());
  ipcMain.handle("app:checkCoreUpdate", () => checkForCoreUpdate());

  ipcMain.handle("app:updatePi", async () => {
    // Resolve first so the source is known for sure (the old guard consulted
    // a cache that was empty when no thread had been opened yet — a race).
    let managed = false;
    let kind = runtimeKind();
    try {
      await resolvePiRuntime(getConfig().ompBinPath);
      managed = isAppManagedRuntime();
      kind = runtimeKind();
    } catch {
      managed = false; // fall through to the CLI path, which surfaces the same error
    }

    if (managed) {
      // App-managed runtime (bundled or a previous in-app update): omp's own
      // `update` refuses these installs, so run our updater instead. It
      // installs the new binary under userData/runtime/versions/<version> and
      // switches current.json; new threads pick it up without replacing files
      // held by the currently running app.
      const result = await installCoreUpdate((p) => send("pi:coreUpdate", p));
      if (result.updated) {
        dropWarmBridge(); // standby runs the old version; respawn from the new tree
        ensureWarmBridge();
      }
      return {
        ok: result.ok,
        managed: true,
        kind,
        updated: result.updated,
        from: result.from ?? null,
        to: result.to ?? null,
        output: result.message,
      };
    }

    // System-installed omp: it can self-update.
    const res = await runOmpCli(["update"]);
    resetPiRuntime(); // pick up the new version on next thread open
    return { ok: res.code === 0, managed: false, kind, code: res.code, output: (res.stdout + res.stderr).trim() };
  });

  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // ---- edit menu (clipboard on the focused field) ------------------------
  ipcMain.handle("app:editAction", (_e, action: "copy" | "cut" | "paste" | "delete" | "selectAll") => {
    const wc = getWin()?.webContents;
    if (!wc) return { ok: false };
    if (action === "copy") wc.copy();
    else if (action === "cut") wc.cut();
    else if (action === "paste") wc.paste();
    else if (action === "delete") wc.delete();
    else if (action === "selectAll") wc.selectAll();
    return { ok: true };
  });

  // ---- window chrome (frameless) -----------------------------------------
  ipcMain.handle("window:minimize", () => getWin()?.minimize());
  ipcMain.handle("window:maximize", () => {
    const w = getWin();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle("window:close", () => getWin()?.close());
  ipcMain.handle("window:isMaximized", () => !!getWin()?.isMaximized());

  // ---- background scheduler ----------------------------------------------
  startScheduler((p) => send("pi:automation", p));

  // ---- warm spare ----------------------------------------------------------
  // Boot one standby pi process so the first thread open is fast too.
  ensureWarmBridge();
}
