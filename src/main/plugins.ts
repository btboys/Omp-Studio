import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { getConfig } from "./config";
import { resolvePiRuntime } from "./pi-bridge";
import { getAgentDir } from "./session-store";

/**
 * Manage omp extension files and standalone skills.
 *
 * Managed plugins: `omp plugin` installs packages into `~/.omp/plugins/` and
 * records them in `omp-plugins.lock.json`. Studio lists those first so the UI
 * matches `omp plugin list`.
 *
 * Local extensions: omp also discovers `*.ts` / `*.js` modules (plus subdirectory
 * packages) from `~/.omp/agent/extensions/`. File extensions can be toggled by
 * renaming to `*.disabled`. Directory packages and npm plugins are toggled with
 * `omp plugin enable/disable`.
 *
 * Skills: omp loads `<skillsDir>/<name>/SKILL.md` and honours the frontmatter
 * flag `enabled: false` (there is no rename-based disable). We toggle that
 * flag, preserving the rest of the file.
 */

export interface PluginPackage {
  source: string;
  name: string;
  kind: "npm" | "git" | "local";
  enabled: boolean;
  version?: string;
}

export interface SkillInfo {
  name: string;
  path: string;
  root: string;
  enabled: boolean;
}

function extensionsDir(): string {
  return join(getAgentDir(), "extensions");
}

function ompPluginsDir(): string {
  return join(homedir(), ".omp", "plugins");
}

/** True when `source` is a filesystem path under agent extensions (not an npm name). */
export function isLocalExtensionSource(source: string): boolean {
  if (!source) return false;
  if (isAbsolute(source)) return true;
  // Relative paths are uncommon; treat existing files as local extensions.
  try {
    return existsSync(source) && (statSync(source).isFile() || statSync(source).isDirectory());
  } catch {
    return false;
  }
}

/** A file extension is "enabled" when it exists without a .disabled suffix. */
function extState(name: string): { base: string; enabled: boolean } {
  if (name.endsWith(".disabled")) return { base: name.slice(0, -".disabled".length), enabled: false };
  return { base: name, enabled: true };
}

function kindFromDependencySpec(spec: string | undefined): "npm" | "git" {
  if (!spec) return "npm";
  const s = spec.trim();
  if (/^(git\+|git:|ssh:\/\/|git@)/i.test(s)) return "git";
  if (/^https?:\/\//i.test(s) && /github\.com|gitlab\.com|bitbucket\.org/i.test(s)) return "git";
  return "npm";
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Packages managed by `omp plugin` under ~/.omp/plugins. */
function listManagedPackages(): PluginPackage[] {
  const dir = ompPluginsDir();
  const lock = readJsonFile<{ plugins?: Record<string, { version?: string; enabled?: boolean }> }>(join(dir, "omp-plugins.lock.json"));
  const pkg = readJsonFile<{ dependencies?: Record<string, string> }>(join(dir, "package.json"));
  const deps = pkg?.dependencies || {};
  const lockPlugins = lock?.plugins || {};

  const names = new Set<string>([...Object.keys(lockPlugins), ...Object.keys(deps)]);
  const out: PluginPackage[] = [];
  for (const name of names) {
    const entry = lockPlugins[name];
    let version = entry?.version;
    if (!version) {
      const nested = readJsonFile<{ version?: string }>(join(dir, "node_modules", ...name.split("/"), "package.json"));
      version = nested?.version;
    }
    out.push({
      source: name,
      name,
      kind: kindFromDependencySpec(deps[name]),
      enabled: entry?.enabled !== false,
      version,
    });
  }
  return out;
}

function listLocalPackages(managedNames: Set<string>): PluginPackage[] {
  const dir = extensionsDir();
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PluginPackage[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const { base, enabled } = extState(entry.name);
    const absEntry = join(dir, entry.name);
    const enabledPath = join(dir, base);
    const isFileExt = /\.(ts|js)$/i.test(base);
    const isPkgDir =
      entry.isDirectory() &&
      (existsSync(join(absEntry, "package.json")) || existsSync(join(absEntry, "index.ts")) || existsSync(join(absEntry, "index.js")));
    if (!isFileExt && !isPkgDir) continue;

    const displayName = basename(base).replace(/\.(ts|js)$/i, "");
    // Prefer the managed npm/git entry when the same plugin also exists as a
    // local copy under agent/extensions (common for linked installs).
    if (managedNames.has(displayName.toLowerCase()) || managedNames.has(base.toLowerCase())) continue;

    out.push({
      // Always point at the enabled path so toggle/remove don't accumulate
      // `.disabled` suffixes after a reload.
      source: enabledPath,
      name: displayName,
      kind: "local",
      enabled: isPkgDir ? true : enabled,
    });
  }
  return out;
}

export function listPackages(): PluginPackage[] {
  const managed = listManagedPackages();
  const managedNames = new Set(managed.map((p) => p.name.toLowerCase()));
  const local = listLocalPackages(managedNames);
  return [...managed, ...local].sort((a, b) => a.name.localeCompare(b.name));
}

export async function setPackageEnabled(source: string, enabled: boolean): Promise<void> {
  if (isLocalExtensionSource(source)) {
    const on = source.endsWith(".disabled") ? source.slice(0, -".disabled".length) : source;
    const off = `${on}.disabled`;
    const target = existsSync(on) ? on : existsSync(off) ? off : null;
    if (!target) throw new Error("Extension not found: " + source);
    if (statSync(target).isDirectory()) {
      throw new Error("Directory extensions are managed with `omp plugin enable/disable`.");
    }
    if (enabled && existsSync(off)) renameSync(off, on);
    else if (!enabled && existsSync(on)) renameSync(on, off);
    return;
  }

  const action = enabled ? "enable" : "disable";
  const res = await runOmpCli(["plugin", action, source]);
  if (res.code !== 0) {
    const detail = (res.stdout + res.stderr).trim() || `omp plugin ${action} exited with code ${res.code}`;
    throw new Error(detail);
  }
}

export function removePackageEntry(path: string): void {
  const on = path.endsWith(".disabled") ? path.slice(0, -".disabled".length) : path;
  const candidates = [on, `${on}.disabled`].filter((p) => existsSync(p));
  if (candidates.length === 0) throw new Error("Extension not found: " + path);
  for (const candidate of candidates) {
    const st = statSync(candidate);
    if (st.isDirectory()) {
      throw new Error("Directory extensions are managed with `omp plugin uninstall`.");
    }
    renameSync(candidate, `${candidate}.removed-${Date.now()}`);
  }
}

/** Run an omp CLI command (plugin install/uninstall/upgrade, update) and capture its output. */
export function runOmpCli(
  args: string[],
  onLine?: (line: string) => void,
  timeoutMs?: number,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  void (async () => {
    let rt: { bin: string };
    try {
      rt = await resolvePiRuntime(getConfig().ompBinPath);
    } catch (e) {
      reject(e);
      return;
    }
    // NB: stdin must be ignored, not left as an open pipe — omp `-p` treats a
    // piped stdin without EOF as "prompt coming via stdin" and waits forever.
    // cwd defaults to the agent dir for CLI management commands.
    const proc = spawn(rt.bin, args, { cwd: cwd ?? getAgentDir(), env: { ...process.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          stderr += `\ntimed out after ${timeoutMs}ms`;
          proc.kill("SIGKILL");
        }, timeoutMs)
      : undefined;
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
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  })();
  return promise;
}

/**
 * Verify that omp can still boot and answer RPC requests after a package
 * mutation. `omp plugin install` only proves that npm/git completed; a
 * malformed or incompatible extension may still make every subsequently
 * opened thread exit during extension discovery.
 */
export function probeOmpStartup(timeoutMs = 20_000): Promise<{ ok: boolean; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; output: string }>();
  void (async () => {
    let rt: { bin: string };
    try {
      rt = await resolvePiRuntime(getConfig().ompBinPath);
    } catch (e) {
      resolve({ ok: false, output: (e as Error)?.message || String(e) });
      return;
    }

    const proc = spawn(rt.bin, ["--mode", "rpc", "--no-session", "--no-rules"], {
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
            if (msg.success === false) finish(false, msg.error || "omp startup probe failed");
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
        finish(false, `omp exited during extension loading (code=${code}, signal=${signal})${detail ? `\n${detail}` : ""}`);
      }
    });

    const timer = setTimeout(() => {
      finish(false, `omp did not answer the startup check within ${Math.round(timeoutMs / 1000)}s${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
    }, timeoutMs);

    proc.stdin.write(JSON.stringify({ id: requestId, type: "get_state" }) + "\n", (err) => {
      if (err) finish(false, err.message);
    });
  })();
  return promise;
}

/* ----------------------------- skills ----------------------------- */

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * omp's native skill locations are `<project>/.omp/skills` and
 * `~/.omp/agent/skills` (directory-per-skill with a SKILL.md inside). We also
 * scan the legacy pi/.agents roots so existing installs keep showing up.
 */
/** All possible skill root directories (used by listSkills for display + setSkillsLoadGlobal for batch toggle). */
function allSkillRoots(cwd?: string): string[] {
  const roots = [join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills")];
  if (cwd) {
    roots.push(join(cwd, ".omp", "skills"), join(cwd, ".pi", "skills"));
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = pathKey(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * omp's native skill locations are `<project>/.omp/skills` and
 * `~/.omp/agent/skills` (directory-per-skill with a SKILL.md inside). We also
 * scan the legacy pi/.agents roots so existing installs keep showing up.
 *
 * When skillsLoadGlobal is false, no roots are returned → skills are not listed
 * or loaded by omp. setSkillsLoadGlobal still scans all roots to batch-toggle
 * the frontmatter flag.
 */
function skillRoots(cwd?: string): string[] {
  if (getConfig().skillsLoadGlobal === false) {
    // Only project-level skills remain active when global loading is off.
    const roots: string[] = [];
    if (cwd) {
      roots.push(join(cwd, ".omp", "skills"), join(cwd, ".pi", "skills"));
    }
    return roots;
  }
  return allSkillRoots(cwd);
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

  const isEnabled = (skillFile: string): boolean => {
    try {
      const text = readFileSync(skillFile, "utf8");
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!m) return true;
      return !/^\s*enabled\s*:\s*false\s*$/m.test(m[1]);
    } catch {
      return true;
    }
  };

  for (const root of skillRoots(cwd)) {
    if (!existsSync(root)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) continue;
      const skillFile = join(root, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      add(entry.name, skillFile, root, isEnabled(skillFile));
    }
  }
  return out;
}

/**
 * Batch-toggle ALL omp-discovered skills when the "load skills" switch changes.
 * Scans every skill root (global, legacy, project-level) and updates each
 * SKILL.md frontmatter so omp stops/starts loading them.
 */
export function setSkillsLoadGlobal(load: boolean): void {
  // Only toggle global and legacy roots; project-level skills are always kept.
  const globalRoots = [join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills")];
  for (const root of globalRoots) {
    if (!existsSync(root)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      const skillFile = join(root, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      setSkillEnabled(skillFile, load);
    }
  }
}

/** Toggle a skill via omp's native frontmatter flag `enabled: false`. */
export function setSkillEnabled(path: string, enabled: boolean): void {
  if (!existsSync(path)) throw new Error("Skill not found: " + path);
  let text = readFileSync(path, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (m) {
    const fm = m[1].split(/\r?\n/);
    const without = fm.filter((line) => !/^\s*enabled\s*:\s*false\s*$/.test(line));
    let next: string[];
    if (!enabled) next = [...without, "enabled: false"];
    else next = without;
    const body = text.slice(m[0].length);
    text = `---\n${next.join("\n")}\n---${body}`;
  } else if (!enabled) {
    text = `---\nenabled: false\n---\n\n${text}`;
  }
  writeFileSync(path, text, "utf8");
}
