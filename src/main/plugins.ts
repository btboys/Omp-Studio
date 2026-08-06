import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getConfig } from "./config";
import { resolvePiRuntime } from "./pi-bridge";
import { getAgentDir } from "./session-store";

/**
 * Manage pi packages (extensions bundles) and standalone skills.
 *
 * Packages live in `~/.pi/agent/settings.json` under `packages`. pi supports a
 * per-package object form with `autoload: false` to keep a package installed
 * but load none of its resources — that is our enable/disable mechanism, and it
 * is native to pi (reversible and survives `pi list`).
 *
 * Standalone skills are auto-discovered from skills directories. pi has no
 * per-skill disable setting, so we toggle discovery by renaming the skill's
 * entry file (SKILL.md <-> SKILL.md.disabled, or foo.md <-> foo.md.disabled).
 * This is reversible and pi honours it on next start.
 */

export interface PluginPackage {
  source: string;
  name: string;
  kind: "npm" | "git" | "local";
  enabled: boolean;
}

export interface SkillInfo {
  name: string;
  path: string;
  root: string;
  enabled: boolean;
}

type PackageEntry = string | { source: string; autoload?: boolean; [k: string]: unknown };

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(obj: Record<string, unknown>): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), "utf8");
}

function entrySource(e: PackageEntry): string {
  return typeof e === "string" ? e : e.source;
}

function entryEnabled(e: PackageEntry): boolean {
  return typeof e === "string" ? true : e.autoload !== false;
}

function kindOf(source: string): "npm" | "git" | "local" {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || /^(https?|ssh|git):\/\//.test(source) || source.includes("github.com")) return "git";
  return "local";
}

function nameOf(source: string): string {
  let s = source.replace(/^(npm|git):/, "");
  s = s.replace(/^(https?|ssh|git):\/\//, "");
  s = s.split("@").slice(0, s.startsWith("@") ? 2 : 1).join("@") || s;
  const seg = s.split(/[\\/]/).filter(Boolean).pop() || s;
  return seg.replace(/\.git$/, "");
}

export function listPackages(): PluginPackage[] {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  return packages.map((e) => {
    const source = entrySource(e);
    return { source, name: nameOf(source), kind: kindOf(source), enabled: entryEnabled(e) };
  });
}

export function setPackageEnabled(source: string, enabled: boolean): void {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  const next = packages.map((e): PackageEntry => {
    if (entrySource(e) !== source) return e;
    if (enabled) {
      // Restore to full autoload. Keep any explicit filters the user had.
      if (typeof e === "string") return e;
      const o = { ...e, autoload: true };
      return o;
    }
    // Disable: keep installed, load nothing.
    if (typeof e === "string") return { source, autoload: false };
    return { ...e, autoload: false };
  });
  writeSettings({ ...settings, packages: next });
}

export function addPackage(source: string): void {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  if (packages.some((e) => entrySource(e) === source)) return;
  writeSettings({ ...settings, packages: [...packages, source] });
}

export function removePackageEntry(source: string): void {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  writeSettings({ ...settings, packages: packages.filter((e) => entrySource(e) !== source) });
}

/** Run a pi CLI command (install/remove/update/list) and capture its output. */
export function runPiCli(args: string[], onLine?: (line: string) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(async (resolve, reject) => {
    let rt: { node: string; cli: string };
    try {
      rt = await resolvePiRuntime(getConfig().piCliPath);
    } catch (e) {
      reject(e);
      return;
    }
    const proc = spawn(rt.node, [rt.cli, ...args], { cwd: getAgentDir(), env: { ...process.env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      s.split(/\r?\n/).forEach((l) => l.trim() && onLine?.(l));
    });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      s.split(/\r?\n/).forEach((l) => l.trim() && onLine?.(l));
    });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Verify that Pi can still boot and answer RPC requests after a package
 * mutation. `pi install` only proves that npm/git completed; a malformed or
 * incompatible extension may still make every subsequently opened thread
 * exit during extension discovery.
 */
export function probePiStartup(timeoutMs = 20_000): Promise<{ ok: boolean; output: string }> {
  return new Promise(async (resolve) => {
    let rt: { node: string; cli: string };
    try {
      rt = await resolvePiRuntime(getConfig().piCliPath);
    } catch (e) {
      resolve({ ok: false, output: (e as Error)?.message || String(e) });
      return;
    }

    const proc = spawn(rt.node, [rt.cli, "--mode", "rpc", "--no-session", "--offline"], {
      cwd: getAgentDir(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const requestId = `pi-studio-plugin-probe-${Date.now()}`;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc.exitCode === null) proc.kill();
      resolve({ ok, output: output.trim() });
    };

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg?.type === "response" && msg?.id === requestId) {
            if (msg.success === false) finish(false, msg.error || "Pi startup probe failed");
            else finish(true, "");
          }
        } catch {
          // Ignore non-RPC startup output. PiBridge does the same.
        }
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    proc.on("error", (err) => finish(false, err.message));
    proc.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || stdout.trim();
        finish(false, `Pi exited during extension loading (code=${code}, signal=${signal})${detail ? `\n${detail}` : ""}`);
      }
    });

    const timer = setTimeout(() => {
      finish(false, `Pi did not answer the startup check within ${Math.round(timeoutMs / 1000)}s${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
    }, timeoutMs);

    proc.stdin.write(JSON.stringify({ id: requestId, type: "get_state" }) + "\n", (err) => {
      if (err) finish(false, err.message);
    });
  });
}

/* ----------------------------- skills ----------------------------- */

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Pi's native locations are `~/.pi/agent/skills` and `<project>/.pi/skills`.
 * Keep the singular `skill` variants for existing local installs, and include
 * the commonly used `~/.agents/skills` location. The latter is passed to pi as
 * an explicit skill path so the Plugins list and Commands menu describe the
 * same runtime.
 */
function skillRoots(cwd?: string): string[] {
  const roots = [
    join(getAgentDir(), "skills"),
    join(getAgentDir(), "skill"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".agents", "skill"),
  ];
  if (cwd) {
    roots.push(
      join(cwd, ".pi", "skills"),
      join(cwd, ".pi", "skill"),
      join(cwd, ".pi", "agent", "skills"),
      join(cwd, ".pi", "agent", "skill"),
    );
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = pathKey(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Return non-default skill directories that must be passed to `pi --skill`. */
export function getAdditionalSkillPaths(cwd?: string): string[] {
  const nativeRoots = new Set<string>([pathKey(join(getAgentDir(), "skills"))]);
  if (cwd) nativeRoots.add(pathKey(join(cwd, ".pi", "skills")));
  return skillRoots(cwd).filter((root) => existsSync(root) && !nativeRoots.has(pathKey(root)));
}

export function listSkills(cwd?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();

  const add = (name: string, path: string, root: string, enabled: boolean) => {
    const key = pathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, path, root, enabled });
  };

  /** Match pi's recursive discovery: a directory containing SKILL.md is a
   * skill root and stops traversal; otherwise nested directories are scanned. */
  const scan = (dir: string, root: string, includeRootFiles: boolean) => {
    if (!existsSync(dir)) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const enabledEntry = entries.find((entry) => entry.name === "SKILL.md" && entry.isFile());
    const disabledEntry = entries.find((entry) => entry.name === "SKILL.md.disabled" && entry.isFile());
    if (enabledEntry || disabledEntry) {
      add(basename(dir), dir, root, !!enabledEntry);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(abs, root, false);
      } else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) {
        add(entry.name.replace(/\.md$/, ""), abs, root, true);
      } else if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md.disabled")) {
        add(entry.name.replace(/\.md\.disabled$/, ""), abs, root, false);
      }
    }
  };

  for (const root of skillRoots(cwd)) scan(root, root, true);
  return out;
}

export function setSkillEnabled(path: string, enabled: boolean): void {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    throw new Error("Skill path not found: " + path);
  }
  if (isDir) {
    const on = join(path, "SKILL.md");
    const off = join(path, "SKILL.md.disabled");
    if (enabled && existsSync(off)) renameSync(off, on);
    else if (!enabled && existsSync(on)) renameSync(on, off);
  } else {
    // root .md file
    if (enabled && path.endsWith(".md.disabled")) renameSync(path, path.replace(/\.disabled$/, ""));
    else if (!enabled && path.endsWith(".md")) renameSync(path, path + ".disabled");
  }
}
