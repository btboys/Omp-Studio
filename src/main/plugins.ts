import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getConfig } from "./config";
import { resolvePiRuntime } from "./pi-bridge";
import { getAgentDir } from "./session-store";

/**
 * Manage omp extension files and standalone skills.
 *
 * Extensions: omp discovers `*.ts` and `*.js` modules (plus subdirectory
 * `index.{ts,js}` files and `package.json` packages) from
 * `~/.omp/agent/extensions/` (and the project `.omp/extensions/`). We list the
 * agent-level ones. Because discovery globs `*.{ts,js}` at the top level, a
 * file renamed to `*.disabled` disappears from discovery — that is our
 * enable/disable mechanism for file extensions (reversible). Directory
 * packages are listed but not toggleable in-app; manage those with `omp
 * plugin`.
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

/** A file extension is "enabled" when it exists without a .disabled suffix. */
function extState(name: string): { base: string; enabled: boolean } {
  if (name.endsWith(".disabled")) return { base: name.slice(0, -".disabled".length), enabled: false };
  return { base: name, enabled: true };
}

export function listPackages(): PluginPackage[] {
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
    const abs = join(dir, entry.name);
    const { base, enabled } = extState(entry.name);
    const isFileExt = /\.(ts|js)$/i.test(base);
    const isPkgDir = entry.isDirectory() && (existsSync(join(abs, "package.json")) || existsSync(join(abs, "index.ts")) || existsSync(join(abs, "index.js")));
    if (!isFileExt && !isPkgDir) continue;
    // Directory packages are always "enabled" (renaming the dir does not hide
    // it from omp's `*/package.json` glob) — manage them with `omp plugin`.
    out.push({ source: abs, name: basename(base), kind: "local", enabled: isPkgDir ? true : enabled });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function setPackageEnabled(path: string, enabled: boolean): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    // Directory packages cannot be disabled by rename; surface a clear error.
    throw new Error("Directory extensions are managed with `omp plugin enable/disable`.");
  }
  const on = path;
  const off = `${path}.disabled`;
  if (enabled && existsSync(off)) renameSync(off, on);
  else if (!enabled && existsSync(on)) renameSync(on, off);
}

export function removePackageEntry(path: string): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    throw new Error("Directory extensions are managed with `omp plugin uninstall`.");
  }
  renameSync(path, `${path}.removed-${Date.now()}`);
}

/** Run an omp CLI command (plugin install/uninstall/upgrade, update) and capture its output. */
export function runOmpCli(args: string[], onLine?: (line: string) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  void (async () => {
    let rt: { bin: string };
    try {
      rt = await resolvePiRuntime(getConfig().ompBinPath);
    } catch (e) {
      reject(e);
      return;
    }
    const proc = spawn(rt.bin, args, { cwd: getAgentDir(), env: { ...process.env }, windowsHide: true });
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
function skillRoots(cwd?: string): string[] {
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
