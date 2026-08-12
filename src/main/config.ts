import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persisted, app-level settings. Stored under Electron's userData dir so it is
 * independent from omp's own ~/.omp/agent config (which we intentionally share
 * with the terminal omp for models / extensions / auth).
 */
export interface ArchivedThread {
  /** Stable session file path used as the thread id. */
  file: string;
  /** Project folder that owns the session. */
  cwd: string;
  /** Title captured when the thread was archived, for the restore list. */
  title: string;
}

/** Built-in OS desktop notification preferences (independent of code-notify). */
export interface DesktopNotifyConfig {
  /** Master switch. */
  enabled: boolean;
  /** Notify when an agent turn settles (idle). */
  onIdle: boolean;
  /** Notify when Sandbox / extension UI needs confirmation. */
  onApproval: boolean;
  /** Notify on omp process errors / unexpected exits. */
  onError: boolean;
  /** Skip OS notifications for the active tab while the window is focused (default true). Background tabs still notify. */
  onlyWhenUnfocused: boolean;
}

export interface AppConfig {
  /**
   * Path to the omp (oh-my-pi) binary, or empty string to auto-detect
   * (bundled runtime → PATH). The bridge spawns the binary directly with
   * shell:false, so this must be an executable file path, not a shell command.
   */
  ompBinPath: string;
  /** Projects the user opened manually; shown pinned at the top of the sidebar. */
  pinnedProjects: string[];
  /** User drag order of top-level sidebar items: project cwds, group names, and worktree repo commonDirs. */
  projectOrder: string[];
  /** User-defined project groups: group name → ordered member project cwds. */
  projectGroups: Record<string, string[]>;
  /** Project folders hidden from normal navigation until restored in Settings. */
  archivedProjects: string[];
  /** Individual sessions hidden from normal navigation until restored in Settings. */
  archivedThreads: ArchivedThread[];
  /** Last window geometry, restored on launch. */
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  /** "dark" | "light" | "system". */
  theme: "dark" | "light" | "system";
  /** UI language. Follows the OS locale until the user pins one in Settings. */
  language: "en" | "zh";
  /** Per-thread permission level, keyed by session file path. Defaults to "sandbox" when absent. */
  threadPermissions: Record<string, "sandbox" | "full" | "auto">;
  /** Per-thread advisor (advisory note) enablement, keyed by session file path. Absent = disabled (new conversations start with advisory off). */
  threadAdvisories: Record<string, boolean>;
  /** Per-thread plan-mode (plan-role model routing) toggle, keyed by session file path. */
  threadPlanModes: Record<string, boolean>;
  /** cwd of the most recently opened thread; seeds the warm spare's project. */
  lastThreadCwd?: string;
  /** User-defined scheduled automation tasks. */
  automationTasks: AutomationTask[];
  /** Built-in desktop notifications for idle / approval / error. */
  desktopNotify: DesktopNotifyConfig;
}

export type ScheduleFrequency = "hourly" | "daily" | "weekly";

export interface TaskSchedule {
  frequency: ScheduleFrequency;
  /** hourly: minute of the hour (0-59). */
  minute?: number;
  /** daily/weekly: "HH:MM" (24h). */
  time?: string;
  /** weekly: days of week, 0=Sun .. 6=Sat. */
  days?: number[];
}

export interface AutomationTask {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  schedule: TaskSchedule;
  enabled: boolean;
  /** Sandbox is the safe default; full must be selected explicitly. */
  permission: "sandbox" | "full";
  lastRunAt?: number;
  lastRunSlot?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

export const DEFAULT_DESKTOP_NOTIFY: DesktopNotifyConfig = {
  enabled: true,
  onIdle: true,
  onApproval: true,
  onError: true,
  onlyWhenUnfocused: true,
};

const DEFAULTS: AppConfig = {
  ompBinPath: "",
  pinnedProjects: [],
  projectOrder: [],
  projectGroups: {},
  archivedProjects: [],
  archivedThreads: [],
  theme: "light",
  language: "en",
  threadPermissions: {},
  threadAdvisories: {},
  threadPlanModes: {},
  automationTasks: [],
  desktopNotify: { ...DEFAULT_DESKTOP_NOTIFY },
};

/** Map an OS locale (e.g. "zh-CN", "en-US") to the app language; non-Chinese locales fall back to English. */
function localeToLanguage(locale?: string): "en" | "zh" {
  return (locale || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let cached: AppConfig | null = null;
let cachedDir = "";

function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function loadConfig(userDataDir: string, systemLocale?: string): AppConfig {
  cachedDir = userDataDir;
  const file = configPath(userDataDir);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig> & { piCliPath?: string };
      // Migration: pre-omp builds stored the pi cli path under `piCliPath`.
      if (!parsed.ompBinPath && parsed.piCliPath) parsed.ompBinPath = parsed.piCliPath;
      cached = {
        ...DEFAULTS,
        ...parsed,
        automationTasks: (parsed.automationTasks || []).map((task) => ({
          ...task,
          permission: task.permission === "full" ? "full" : "sandbox",
        })),
        desktopNotify: {
          ...DEFAULT_DESKTOP_NOTIFY,
          ...(parsed.desktopNotify || {}),
        },
      };
      // A stored `language` key means the user pinned it in Settings. Otherwise
      // default to the OS locale (zh-* → 中文, anything else → English) and
      // persist it so the sandbox gate, which reads config.json from disk,
      // shows the same language.
      if (parsed.language !== "en" && parsed.language !== "zh") {
        cached.language = localeToLanguage(systemLocale);
        if (!existsSync(cachedDir)) mkdirSync(cachedDir, { recursive: true });
        writeFileSync(file, JSON.stringify(cached, null, 2), "utf8");
      }
      return cached;
    } catch {
      // corrupt file -> fall back to defaults but keep a copy
    }
  }
  cached = { ...DEFAULTS, desktopNotify: { ...DEFAULT_DESKTOP_NOTIFY } };
  cached.language = localeToLanguage(systemLocale);
  // Fresh install: persist the resolved language so the sandbox gate (which
  // reads config.json from disk) agrees. Skip when the file exists but was
  // corrupt — keep it untouched for manual recovery.
  if (!existsSync(file)) {
    if (!existsSync(cachedDir)) mkdirSync(cachedDir, { recursive: true });
    writeFileSync(file, JSON.stringify(cached, null, 2), "utf8");
  }
  return cached;
}

export function getConfig(): AppConfig {
  if (!cached) throw new Error("config not loaded; call loadConfig() after app ready");
  return cached;
}

/** The userData directory that holds config.json (used for runtime assets like the gate extension). */
export function getConfigDir(): string {
  return cachedDir;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  if (!cached) throw new Error("config not loaded");
  cached = {
    ...cached,
    ...patch,
    desktopNotify: patch.desktopNotify
      ? { ...DEFAULT_DESKTOP_NOTIFY, ...cached.desktopNotify, ...patch.desktopNotify }
      : cached.desktopNotify,
  };
  if (!existsSync(cachedDir)) mkdirSync(cachedDir, { recursive: true });
  writeFileSync(configPath(cachedDir), JSON.stringify(cached, null, 2), "utf8");
  return cached;
}
