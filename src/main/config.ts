import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

export interface AppConfig {
  /**
   * Path to the omp (oh-my-pi) binary, or empty string to auto-detect
   * (bundled runtime → PATH). The bridge spawns the binary directly with
   * shell:false, so this must be an executable file path, not a shell command.
   */
  ompBinPath: string;
  /** Projects the user opened manually; shown pinned at the top of the sidebar. */
  pinnedProjects: string[];
  /** Project folders hidden from normal navigation until restored in Settings. */
  archivedProjects: string[];
  /** Individual sessions hidden from normal navigation until restored in Settings. */
  archivedThreads: ArchivedThread[];
  /** Last window geometry, restored on launch. */
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  /** "dark" | "light" | "system". */
  theme: "dark" | "light" | "system";
  /** UI language. English is the default for new installations. */
  language: "en" | "zh";
  /** Per-thread permission level, keyed by session file path. Defaults to "sandbox" when absent. */
  threadPermissions: Record<string, "sandbox" | "full">;
  /** cwd of the most recently opened thread; seeds the warm spare's project. */
  lastThreadCwd?: string;
  /** User-defined scheduled automation tasks. */
  automationTasks: AutomationTask[];
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

const DEFAULTS: AppConfig = {
  ompBinPath: "",
  pinnedProjects: [],
  archivedProjects: [],
  archivedThreads: [],
  theme: "light",
  language: "en",
  threadPermissions: {},
  automationTasks: [],
};

let cached: AppConfig | null = null;
let cachedDir = "";

function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function loadConfig(userDataDir: string): AppConfig {
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
      };
      return cached;
    } catch {
      // corrupt file -> fall back to defaults but keep a copy
    }
  }
  cached = { ...DEFAULTS };
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
  cached = { ...cached, ...patch };
  if (!existsSync(cachedDir)) mkdirSync(cachedDir, { recursive: true });
  writeFileSync(configPath(cachedDir), JSON.stringify(cached, null, 2), "utf8");
  return cached;
}
