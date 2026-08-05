import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate } from "./app-updater";
import { checkForCoreUpdate, installCoreUpdate } from "./core-updater";
import { getConfig, getConfigDir, updateConfig, type AutomationTask } from "./config";
import { listDir } from "./fs-service";
import { createHtmlPreviewUrl } from "./html-preview-protocol";
import {
  getAuthPath,
  getDiagnostics,
  getModelsPath,
  getSettingsPath,
  readModelsFile,
  readThinking,
  testModelAvailability,
  writeModelsProviders,
  writeThinking,
} from "./models-service";
import { PiBridge, isAppManagedRuntime, resetPiRuntime, resolvePiRuntime, runtimeKind } from "./pi-bridge";
import { createGateModeFile, ensureGateExtension, removeGateModeFile, writeGateMode } from "./permission-gate";
import { readPreview } from "./preview-service";
import { getAgentDir, getTotalUsage, type ProjectSummary, readThreadHistory, scanProjects, searchThreads, type ThreadSearchHit } from "./session-store";
import { listPackages, listSkills, probePiStartup, removePackageEntry, runPiCli, setPackageEnabled, setSkillEnabled } from "./plugins";
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
  name: string | undefined,
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
    piCliPath: getConfig().piCliPath,
    sessionFile,
    name,
    // The gate extension is always loaded; its sandbox/full behaviour is decided
    // at runtime by the per-thread mode file, so permission can change live.
    extensions: [ensureGateExtension(getConfigDir())],
    gateModeFile,
    onEvent: (e) => send("pi:event", { threadId: id, event: e }),
    onExtUi: (r) => send("pi:extui", { threadId: id, request: r }),
    onExit: (info) => {
      // Only forget the bridge if it is still the one registered under this id
      // (a delayed exit must not evict a bridge that replaced it).
      if (bridges.get(id) === handle) bridges.delete(id);
      if (warmHandle === handle) {
        warmHandle = null;
        if (!info.expected) warmFailures++;
        // eslint-disable-next-line no-console
        console.log(`[pi] warm spare exited (code=${info.code}, expected=${!!info.expected}, failures=${warmFailures})`);
        // Refill unless the spare keeps dying (avoid a crash loop).
        if (warmFailures < 3) setTimeout(() => ensureWarmBridge(), 500);
      }
      removeGateModeFile(gateModeFile);
      // An intentional stop (thread close / app quit) is expected and must not
      // surface as a "pi process exited" error.
      if (!info.expected) send("pi:exit", { threadId: id, ...info });
    },
    onError: (err) => send("pi:error", { threadId: id, message: err.message }),
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
  const handle = createHandle(cwd, undefined, undefined, "sandbox", sendToRenderer);
  warmHandle = handle;
  // eslint-disable-next-line no-console
  console.log("[pi] warm spare spawning (cwd=" + cwd + ")");
  handle.bridge
    .start()
    .then(() => handle.bridge.getState()) // wait until pi answers: fully booted
    .then(() => {
      if (warmHandle === handle) {
        // eslint-disable-next-line no-console
        console.log("[pi] warm spare ready — thread opens are now fast");
      }
    })
    .catch((err) => {
      if (warmHandle === handle) warmHandle = null;
      // A spawned-but-dead process is counted by its onExit handler; only
      // count spawn-time failures here to avoid double counting.
      if (!handle.bridge.running) warmFailures++;
      // eslint-disable-next-line no-console
      console.error("[pi] warm bridge failed to start:", (err as Error)?.message || String(err));
    });
}

/** Kill the standby process (runtime changed, quitting, etc.). */
export function dropWarmBridge(): void {
  if (warmHandle) {
    warmHandle.bridge.stop();
    warmHandle = null;
  }
}

async function gatherThread(bridge: PiBridge, threadId: string, permission: PermissionLevel) {
  const state: any = await bridge.getState();
  const [msgRes, modelsRes, cmdsRes, entriesRes]: any[] = await Promise.all([
    bridge.getMessages(),
    bridge.getAvailableModels(),
    bridge.getCommands().catch(() => ({ commands: [] })),
    bridge.getEntries().catch(() => ({ entries: [], leafId: null })),
  ]);
  return {
    threadId,
    cwd: bridge.cwd,
    sessionFile: state.sessionFile ?? null,
    sessionName: state.sessionName ?? null,
    model: state.model ?? null,
    thinkingLevel: state.thinkingLevel ?? "off",
    isStreaming: !!state.isStreaming,
    messages: msgRes?.messages ?? [],
    branchMessages: activeBranchMessages(entriesRes),
    models: modelsRes?.models ?? [],
    commands: (cmdsRes?.commands ?? []).filter((command: any) => command?.name !== "pi-studio-branch-at"),
    permission,
  };
}

/** Resolve visible user/assistant messages on the active entry branch to their
 * stable session ids. Walking parent links avoids targeting an identically
 * worded reply that belongs to an inactive branch. */
function activeBranchMessages(entriesRes: any): { entryId: string; role: "user" | "assistant"; text: string }[] {
  const entries = Array.isArray(entriesRes?.entries) ? entriesRes.entries : [];
  const byId = new Map(entries.map((entry: any) => [entry?.id, entry]));
  const branch: any[] = [];
  let entry: any = entriesRes?.leafId ? byId.get(entriesRes.leafId) : undefined;
  const seen = new Set<string>();
  while (entry?.id && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  branch.reverse();
  const result: { entryId: string; role: "user" | "assistant"; text: string }[] = [];
  for (const item of branch) {
    const role = item?.message?.role;
    if (item?.type !== "message" || (role !== "user" && role !== "assistant")) continue;
    const content = item.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block: any) => (block?.type === "text" ? block.text || "" : "")).filter(Boolean).join("\n")
          : "";
    result.push({ entryId: item.id, role, text });
  }
  return result;
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

  // ---- app / config -------------------------------------------------------
  ipcMain.handle("app:getVersion", () => app.getVersion());
  ipcMain.handle("app:getConfig", () => getConfig());
  ipcMain.handle("app:setConfig", (_e, patch) => {
    const prev = getConfig().piCliPath;
    const next = updateConfig(patch || {});
    if ((next.piCliPath || "") !== (prev || "")) {
      resetPiRuntime();
      dropWarmBridge(); // standby was booted from the old runtime
      ensureWarmBridge();
    }
    return next;
  });
  ipcMain.handle("app:resolveRuntime", async () => {
    try {
      const rt = await resolvePiRuntime(getConfig().piCliPath);
      // eslint-disable-next-line no-console
      console.log("[pi] runtime resolved ->", "node:", rt.node, "| cli:", rt.cli);
      return { ok: true, node: rt.node, cli: rt.cli };
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[pi] runtime resolve failed:", e?.message || String(e));
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // ---- projects / sessions ------------------------------------------------
  ipcMain.handle("app:getProjects", async (): Promise<ProjectSummary[]> => {
    const scanned = await scanProjects();
    const pinned = getConfig().pinnedProjects || [];
    const archived = new Set((getConfig().archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const visibleScanned = scanned.filter((project) => !archived.has(project.cwd.toLowerCase()));
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
    return (await searchThreads(query)).filter((hit) => !archived.has(hit.cwd.toLowerCase()));
  });

  ipcMain.handle("app:getTotalUsage", () => getTotalUsage());

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
  ipcMain.handle("settings:saveThinking", (_e, patch: Record<string, unknown>) => writeThinking(patch as any));
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
  }));

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
    if (existing) return { connected: true, ...(await gatherThread(existing.bridge, sessionFile, existing.permission)) };
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
      return gatherThread(existing.bridge, sessionFile, existing.permission);
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
        console.log("[pi] thread:open dropping dead warm spare -> cold start");
        dropWarmBridge();
      } else if (!sameDir(warmHandle.bridge.cwd, cwd)) {
        // eslint-disable-next-line no-console
        console.log(`[pi] thread:open cwd mismatch (warm="${warmHandle.bridge.cwd}" requested="${cwd}") -> cold start, spare respawns for new cwd`);
        dropWarmBridge();
      } else {
        handle = warmHandle;
        warmHandle = null;
        adopted = true;
        warmFailures = 0;
        handle.permission = permission;
        writeGateMode(handle.gateModeFile, permission);
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open adopting warm spare" + (sessionFile ? " (switch_session)" : " (fresh)"));
      }
    }
    if (!handle) {
      if (!spareAtEntry && !name) {
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open cold start (no spare available yet)");
      }
      handle = createHandle(cwd, sessionFile, name, permission, send);
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
      return gatherThread(handle.bridge, finalId, permission);
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
    return { cancelled: false, ...(await gatherThread(h.bridge, newId, h.permission)) };
  });

  ipcMain.handle("thread:getBranchMessages", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { messages: [] };
    const entries = await h.bridge.getEntries();
    return { messages: activeBranchMessages(entries) };
  });

  const finishBranch = async (h: BridgeHandle, oldId: string, selectedText?: string) => {
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || oldId;
    h.setId(newId);
    const perms = getConfig().threadPermissions;
    if (state.sessionFile && perms[state.sessionFile] !== h.permission) {
      updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: h.permission } });
    }
    return { ...(await gatherThread(h.bridge, newId, h.permission)), selectedText };
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
    return h.bridge.setSessionName(args.name);
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
  ipcMain.handle("plugins:setPackageEnabled", (_e, args: { source: string; enabled: boolean }) => {
    setPackageEnabled(args.source, args.enabled);
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  ipcMain.handle("plugins:installPackage", async (_e, source: string) => {
    const res = await runPiCli(["install", source]);
    const installOutput = (res.stdout + res.stderr).trim();
    if (res.code !== 0) {
      // Never add a failed/partial install to settings: Pi loads configured
      // packages before RPC starts, so one bad entry can brick every thread.
      return { ok: false, output: installOutput || `pi install exited with code ${res.code}` };
    }
    const probe = await probePiStartup();
    if (!probe.ok) {
      // Keep the package installed but disable autoload. This is reversible in
      // Settings and immediately restores thread startup.
      setPackageEnabled(source, false);
      dropWarmBridge();
      ensureWarmBridge();
      return {
        ok: false,
        output: [installOutput, "Installed, but Pi could not load the extension. It was disabled automatically.", probe.output]
          .filter(Boolean)
          .join("\n"),
      };
    }
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, output: installOutput };
  });
  ipcMain.handle("plugins:removePackage", async (_e, source: string) => {
    const res = await runPiCli(["remove", source]);
    removePackageEntry(source); // ensure it is gone from settings regardless of CLI result
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, output: (res.stdout + res.stderr).trim() };
  });
  ipcMain.handle("plugins:getSkills", () => listSkills());
  ipcMain.handle("plugins:setSkillEnabled", (_e, args: { path: string; enabled: boolean }) => {
    setSkillEnabled(args.path, args.enabled);
    return { ok: true };
  });
  // Update installed extension packages. With no source, updates all of them
  // (`pi update --extensions`); with a source, updates just that package. pi
  // checks installed vs latest internally and only touches outdated packages.
  ipcMain.handle("plugins:updatePackages", async (_e, source?: string) => {
    const args = source ? ["update", source] : ["update", "--extensions"];
    const res = await runPiCli(args);
    if (res.code === 0) {
      dropWarmBridge();
      ensureWarmBridge();
    }
    return { ok: res.code === 0, code: res.code, output: (res.stdout + res.stderr).trim() };
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
  ipcMain.handle("app:checkCoreUpdate", () => checkForCoreUpdate());

  ipcMain.handle("app:updatePi", async () => {
    // Resolve first so the source is known for sure (the old guard consulted
    // a cache that was empty when no thread had been opened yet — a race).
    let managed = false;
    let kind = runtimeKind();
    try {
      await resolvePiRuntime(getConfig().piCliPath);
      managed = isAppManagedRuntime();
      kind = runtimeKind();
    } catch {
      managed = false; // fall through to the CLI path, which surfaces the same error
    }

    if (managed) {
      // App-managed runtime (bundled or a previous in-app update): pi's own
      // `update` refuses these installs, so run our updater instead. It
      // installs the new tree under userData/runtime/pi, which resolution
      // prefers over the bundled copy; new threads pick it up.
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

    // System-installed pi (npm/pnpm global): it can self-update.
    const res = await runPiCli(["update"]);
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
