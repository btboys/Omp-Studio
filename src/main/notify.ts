import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { app, Notification, nativeImage, type BrowserWindow } from "electron";
import { getConfig, type DesktopNotifyConfig } from "./config";

export type NotifyKind = "idle" | "approval" | "error";

export interface DesktopNotifyOptions {
  kind: NotifyKind;
  title: string;
  body: string;
  threadId?: string;
  /** Project cwd — used so clicking the notification can open/switch the tab. */
  cwd?: string;
}

let getWinRef: (() => BrowserWindow | null) | null = null;
let onActivateRef: ((threadId: string, cwd?: string) => void) | null = null;
/** Renderer-reported active tab; used so the focused current tab stays quiet. */
let activeThreadId: string | null = null;
/**
 * Strong refs so Electron Notification objects are not GC'd before the user
 * interacts with them (a common Electron pitfall that drops click handlers).
 */
const liveNotifications = new Set<Notification>();
const MAX_LIVE_NOTIFICATIONS = 20;

function releaseNotification(n: Notification): void {
  liveNotifications.delete(n);
  try {
    n.removeAllListeners();
  } catch {
    // ignore
  }
}

/** Wire window focus + click-to-activate once during IPC registration. */
export function initDesktopNotify(
  getWin: () => BrowserWindow | null,
  onActivate: (threadId: string, cwd?: string) => void,
): void {
  getWinRef = getWin;
  onActivateRef = onActivate;
}

/** Keep main in sync with the renderer's active thread tab. */
export function setActiveNotifyThread(threadId: string | null): void {
  activeThreadId = threadId || null;
}

export function projectLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return basename(trimmed) || trimmed || "project";
}

/** "project · session title" (or just project) for multi-tab discrimination. */
export function threadNotifyLabel(cwd: string, sessionTitle?: string | null): string {
  const project = projectLabel(cwd);
  const title = (sessionTitle || "").trim();
  if (!title) return project;
  const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
  return `${project} · ${short}`;
}

function resolveIconPath(): string | undefined {
  const names = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  const candidates = names.flatMap((name) => [
    join(app.getAppPath(), "resources", name),
    join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || "", name),
  ]);
  return candidates.find((p) => p && existsSync(p));
}

function notifyAllowed(kind: NotifyKind, cfg: DesktopNotifyConfig): boolean {
  if (!cfg.enabled) return false;
  if (kind === "idle" && !cfg.onIdle) return false;
  if (kind === "approval" && !cfg.onApproval) return false;
  if (kind === "error" && !cfg.onError) return false;
  return true;
}

/**
 * Suppress OS notifications for the tab the user is already looking at while
 * the window is focused. Background tabs still notify even when Studio has
 * focus — that is the multi-tab-aware reading of `onlyWhenUnfocused`.
 */
function shouldSuppressForActiveTab(threadId: string | undefined, cfg: DesktopNotifyConfig): boolean {
  if (!cfg.onlyWhenUnfocused) return false;
  const win = getWinRef?.() ?? null;
  const focused = !!(win && !win.isDestroyed() && win.isFocused());
  if (!focused) return false;
  // Focused + no thread id → treat as "don't spam while using the app".
  if (!threadId) return true;
  return threadId === activeThreadId;
}

/**
 * Show an OS desktop notification when the matching preference is on.
 * Failures are swallowed so notification problems never disrupt an agent turn.
 */
export function maybeDesktopNotify(opts: DesktopNotifyOptions): void {
  try {
    const cfg = getConfig().desktopNotify;
    if (!notifyAllowed(opts.kind, cfg)) return;
    if (!Notification.isSupported()) return;
    if (shouldSuppressForActiveTab(opts.threadId, cfg)) return;

    const iconPath = resolveIconPath();
    const n = new Notification({
      title: opts.title,
      body: opts.body,
      silent: false,
      ...(iconPath
        ? {
            icon:
              process.platform === "darwin"
                ? nativeImage.createFromPath(iconPath)
                : iconPath,
          }
        : {}),
    });
    // Cap retained notifications so a stuck platform that never emits "close"
    // cannot grow this set without bound.
    if (liveNotifications.size >= MAX_LIVE_NOTIFICATIONS) {
      const oldest = liveNotifications.values().next().value;
      if (oldest) releaseNotification(oldest);
    }
    liveNotifications.add(n);
    n.on("click", () => {
      const w = getWinRef?.();
      if (w && !w.isDestroyed()) {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      }
      if (opts.threadId) onActivateRef?.(opts.threadId, opts.cwd);
      releaseNotification(n);
    });
    n.on("close", () => releaseNotification(n));
    n.show();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log("[notify] failed:", err);
  }
}
