import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

function skillRoots(): string[] {
  return [join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills")];
}

export function listSkills(): SkillInfo[] {
  const out: SkillInfo[] = [];
  const roots = skillRoots();
  roots.forEach((root, ri) => {
    if (!existsSync(root)) return;
    const allowRootMd = ri === 0; // ~/.pi/agent/skills: root .md files count; ~/.agents/skills: they don't
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(root, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const hasMd = existsSync(join(abs, "SKILL.md"));
        const hasDisabled = existsSync(join(abs, "SKILL.md.disabled"));
        if (hasMd) out.push({ name, path: abs, root, enabled: true });
        else if (hasDisabled) out.push({ name, path: abs, root, enabled: false });
      } else if (allowRootMd && name.endsWith(".md")) {
        out.push({ name: name.replace(/\.md$/, ""), path: abs, root, enabled: true });
      } else if (allowRootMd && name.endsWith(".md.disabled")) {
        out.push({ name: name.replace(/\.md\.disabled$/, ""), path: abs, root, enabled: false });
      }
    }
  });
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
