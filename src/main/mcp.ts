import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "./session-store";

/**
 * Safe read/write access to omp's MCP config (`~/.omp/agent/mcp.json`) plus a
 * read-only aggregation of the other MCP sources omp discovers — Claude Code
 * (`~/.claude.json`) and OpenAI Codex (`~/.codex/config.toml`) — mirroring
 * omp's own `/mcp` view.
 *
 * omp's file shape (see omp's mcp-schema.json):
 *   {
 *     "$schema": "...",
 *     "mcpServers": { "<name>": { type, command|url, args, env, cwd, headers, enabled, ... } },
 *     "disabledServers": ["name"],   // denylist, highest precedence (hides discovered servers)
 *     "enabledServers": ["name"]     // allowlist, overrides a discovered server's enabled:false
 *   }
 *
 * Round-trip safety: parse the existing file, mutate only the keys we own, and
 * write back atomically, so hand-written fields (auth, oauth, timeout, …) and
 * the $schema reference survive untouched. A malformed file throws instead of
 * being silently overwritten.
 *
 * Connection status is probed with a real MCP `initialize` handshake (spawn
 * stdio servers / POST http endpoints), concurrency-capped and cached briefly
 * so the panel does not re-spawn every server on every render.
 */

export type McpSource = "omp" | "claude" | "codex";

export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface McpServerInfo {
  name: string;
  /** Where the server came from: OMP's own mcp.json or a discovered source. */
  source: McpSource;
  /** Effective state: enabled flag in config AND not denylisted. */
  enabled: boolean;
  type: "stdio" | "http" | "sse" | "other";
  /** Command (stdio) or URL (http/sse) for the list subtitle. Empty for unknown entries. */
  endpoint: string;
  /** Live probe result: connected / not connected / disabled (denylisted or enabled:false). */
  status: "connected" | "not-connected" | "disabled";
  /** True when the name is only known from disabledServers/enabledServers (no config anywhere). */
  discovered: boolean;
  config: McpServerConfig;
}

export interface McpState {
  path: string;
  servers: McpServerInfo[];
  disabledServers: string[];
  enabledServers: string[];
  /** The three config sources, in display order, with their paths. */
  sources: { id: McpSource; path: string }[];
}

interface McpFile {
  $schema?: string;
  mcpServers: Record<string, McpServerConfig>;
  disabledServers?: string[];
  enabledServers?: string[];
}

const SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
const NAME_RE = /^[a-zA-Z0-9_.-]{1,100}$/;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CACHE_TTL_MS = 15_000;
const PROBE_CONCURRENCY = 4;

export function getMcpPath(): string {
  return join(getAgentDir(), "mcp.json");
}

function readMcpFile(): McpFile {
  const path = getMcpPath();
  if (!existsSync(path)) return { mcpServers: {} };
  let data: any;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`mcp.json 无法解析（${path}）：${(e as Error)?.message || e}`);
  }
  if (!data || typeof data !== "object") throw new Error(`mcp.json 不是有效的 JSON 对象（${path}）`);
  return {
    $schema: typeof data.$schema === "string" ? data.$schema : undefined,
    mcpServers: data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {},
    disabledServers: Array.isArray(data.disabledServers) ? data.disabledServers.filter((x: unknown) => typeof x === "string") : [],
    enabledServers: Array.isArray(data.enabledServers) ? data.enabledServers.filter((x: unknown) => typeof x === "string") : [],
  };
}

function writeMcpFile(file: McpFile): void {
  const path = getMcpPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out: Record<string, unknown> = { $schema: file.$schema ?? SCHEMA_URL, mcpServers: file.mcpServers };
  if (file.disabledServers?.length) out.disabledServers = file.disabledServers;
  if (file.enabledServers?.length) out.enabledServers = file.enabledServers;
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/* ------------------------------------------------------------------ *
 * Source readers
 * ------------------------------------------------------------------ */

/** Claude Code stores MCP servers in the `mcpServers` key of ~/.claude.json. */
function readClaudeServers(): Record<string, McpServerConfig> {
  const path = join(homedir(), ".claude.json");
  try {
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, "utf8"));
    const servers = data?.mcpServers;
    if (!servers || typeof servers !== "object") return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, raw] of Object.entries(servers)) {
      const cfg = raw as McpServerConfig;
      if (cfg && typeof cfg === "object") out[name] = cfg;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Minimal TOML-subset parser for the `[mcp_servers.*]` sections of
 * ~/.codex/config.toml. Handles `key = "str"`, `key = ["a", "b"]`,
 * `key = true|false|number`, nested `[mcp_servers.X.env]` tables and empty
 * sections. Other sections of the file are ignored.
 */
function readCodexServers(): Record<string, McpServerConfig> {
  const path = join(homedir(), ".codex", "config.toml");
  let text: string;
  try {
    if (!existsSync(path)) return {};
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, McpServerConfig> = {};
  let current: { name: string; cfg: McpServerConfig; env: Record<string, string> } | null = null;

  const parseValue = (raw: string): unknown => {
    const v = raw.trim();
    if (v.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
      if (m) return m[1].replace(/\\(["\\nrt])/g, (_s, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
    }
    if (v.startsWith("[")) {
      const m = /^\[([\s\S]*)\]$/.exec(v);
      if (m) {
        return m[1]
          .split(",")
          .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
          .filter(Boolean);
      }
    }
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      const parts = header[1].trim().split(".");
      if (parts[0] === "mcp_servers" && parts.length >= 2) {
        const name = parts.slice(1).join(".");
        const isEnv = parts[parts.length - 1] === "env" && parts.length >= 3;
        if (isEnv) {
          current = { name: name.slice(0, -4), cfg: out[name.slice(0, -4)] || {}, env: {} };
          out[current.name] = current.cfg;
          continue;
        }
        current = { name, cfg: out[name] || {}, env: {} };
        out[name] = current.cfg;
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = parseValue(trimmed.slice(eq + 1));
    if (key === "env") {
      // inline env = { K = "V", ... } table
      const raw = trimmed.slice(eq + 1).trim();
      if (raw.startsWith("{")) {
        const env: Record<string, string> = {};
        for (const pair of raw.slice(1, -1).split(",")) {
          const i = pair.indexOf("=");
          if (i > 0) env[pair.slice(0, i).trim().replace(/^"(.*)"$/, "$1")] = parseValue(pair.slice(i + 1)) as string;
        }
        current.cfg.env = env;
      }
    } else if (key === "args" || key === "env" || key === "headers" || key === "command" || key === "url" || key === "cwd" || key === "type" || key === "enabled" || key === "timeout") {
      (current.cfg as Record<string, unknown>)[key] = value;
    }
    if (key === "env" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      // handled above; skip
    }
  }
  // Merge nested [mcp_servers.X.env] sections into their server config.
  for (const name of Object.keys(out)) {
    const cfg = out[name];
    if (cfg.env && Object.keys(cfg.env).length === 0) delete cfg.env;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Connection probing
 * ------------------------------------------------------------------ */

const INIT_PAYLOAD = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "omp-studio", version: "0.1" } },
});

async function probeStdio(cfg: McpServerConfig): Promise<boolean> {
  const command = cfg.command;
  if (!command) return false;
  const args = cfg.args || [];
  const env: Record<string, string | undefined> = { ...process.env, ...(cfg.env || {}) };
  return new Promise<boolean>((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      // detached lets us kill the whole process group (npx + the server it
      // spawns); without it the grandchild keeps the stdio pipes open after
      // npx exits and the probe never settles.
      proc = spawn(command, args, {
        cwd: cfg.cwd || getAgentDir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const killGroup = () => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        proc.stdout.destroy();
        proc.stderr.destroy();
        proc.stdin.destroy();
      } catch {
        /* already closed */
      }
    };
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    let buf = "";
    proc.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (/\"jsonrpc\"\s*:\s*\"2\.0\"/.test(buf)) done(true);
      // some servers stream other lines first; keep buffering until timeout
    });
    proc.on("error", () => done(false));
    proc.on("exit", () => done(false));
    try {
      proc.stdin?.write(INIT_PAYLOAD + "\n");
    } catch {
      done(false);
    }
  });
}

async function probeHttp(url: string, headers?: Record<string, string>): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers || {}) },
      body: INIT_PAYLOAD,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const text = await res.text();
    return /\"jsonrpc\"\s*:\s*\"2\.0\"/.test(text) || /\"result\"/.test(text) || /\"tools\"/.test(text);
  } catch {
    return false;
  }
}

/** Legacy SSE endpoints only accept GET; a 200 with event-stream is enough.
 *  The stream never ends, so do not drain the body — abort right away. */
async function probeSse(url: string, headers?: Record<string, string>): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream", ...(headers || {}) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const ctype = res.headers.get("content-type") || "";
    await res.body?.cancel().catch(() => {});
    return res.ok || /text\/event-stream/.test(ctype);
  } catch {
    return false;
  }
}

async function probeServer(s: McpServerInfo): Promise<"connected" | "not-connected"> {
  if (s.type === "http") return (await probeHttp(s.config.url || "", s.config.headers)) ? "connected" : "not-connected";
  if (s.type === "sse") return (await probeSse(s.config.url || "", s.config.headers)) ? "connected" : "not-connected";
  if (s.type === "stdio") return (await probeStdio(s.config)) ? "connected" : "not-connected";
  return "not-connected";
}

/** Run probeServer over an array with a concurrency cap, preserving order. */
async function probeAll(servers: McpServerInfo[]): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < servers.length) {
      const i = next++;
      if (servers[i].status === "disabled") continue;
      servers[i].status = await probeServer(servers[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, servers.length) }, run));
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function describe(info: McpServerConfig): { type: "stdio" | "http" | "sse"; endpoint: string } {
  if (info.type === "http" || info.type === "sse") return { type: info.type, endpoint: info.url || "" };
  return { type: "stdio", endpoint: info.command || "" };
}

/** Keys owned by a transport; anything else (auth, oauth, timeout, …) is preserved. */
function transportKeys(type: "stdio" | "http" | "sse"): (keyof McpServerConfig)[] {
  if (type === "stdio") return ["type", "command", "args", "env", "cwd"];
  return ["type", "url", "headers"];
}

// Probe results are cached briefly (keyed by nothing — the whole set) so rapid
// panel refreshes do not re-spawn every stdio server.
let probeCache: { at: number; statuses: Map<string, "connected" | "not-connected" | "disabled"> } | null = null;

function clearProbeCache(): void {
  probeCache = null;
}

function buildState(): McpState {
  const file = readMcpFile();
  const denied = new Set(file.disabledServers || []);
  const sources: { id: McpSource; path: string }[] = [
    { id: "claude", path: join(homedir(), ".claude.json") },
    { id: "omp", path: getMcpPath() },
    { id: "codex", path: join(homedir(), ".codex", "config.toml") },
  ];

  const rawByName = new Map<string, { source: McpSource; config: McpServerConfig }>();
  for (const [name, config] of Object.entries(file.mcpServers)) rawByName.set(name, { source: "omp", config });
  for (const [name, config] of Object.entries(readClaudeServers())) {
    if (!rawByName.has(name)) rawByName.set(name, { source: "claude", config });
  }
  for (const [name, config] of Object.entries(readCodexServers())) {
    if (!rawByName.has(name)) rawByName.set(name, { source: "codex", config });
  }

  const servers: McpServerInfo[] = [];
  for (const [name, { source, config }] of rawByName) {
    const { type, endpoint } = describe(config);
    const disabled = config.enabled === false || denied.has(name);
    servers.push({
      name,
      source,
      enabled: !disabled,
      type,
      endpoint,
      status: disabled ? "disabled" : "not-connected",
      discovered: false,
      config,
    });
  }
  // Names that appear only in the denylist/allowlist (unknown source).
  for (const name of [...(file.disabledServers || []), ...(file.enabledServers || [])]) {
    if (rawByName.has(name)) continue;
    servers.push({
      name,
      source: "omp",
      enabled: !denied.has(name),
      type: "other",
      endpoint: "",
      status: denied.has(name) ? "disabled" : "not-connected",
      discovered: true,
      config: {},
    });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { path: getMcpPath(), servers, disabledServers: file.disabledServers || [], enabledServers: file.enabledServers || [], sources };
}

/** Aggregate all sources; apply cached statuses when fresh (fast path). */
export async function listMcpServers(): Promise<McpState> {
  const state = buildState();
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_CACHE_TTL_MS) {
    for (const s of state.servers) s.status = probeCache.statuses.get(s.name) || s.status;
  }
  return state;
}

/** Re-probe every server's connection and refresh the cache. */
export async function probeMcpServers(): Promise<McpState> {
  const state = buildState();
  await probeAll(state.servers);
  const statuses = new Map<string, "connected" | "not-connected" | "disabled">();
  for (const s of state.servers) statuses.set(s.name, s.status);
  probeCache = { at: Date.now(), statuses };
  return state;
}

/**
 * Upsert a server definition. The previous config is merged underneath so
 * hand-written fields survive; when the transport changes, keys owned by the
 * old transport (and not the new one) are pruned. Empty transport values
 * (cleared in the editor) are dropped so a cleared env/headers/cwd actually
 * clears instead of lingering in the merge.
 */
export async function saveMcpServer(name: string, config: McpServerConfig): Promise<McpState> {
  if (!NAME_RE.test(name)) throw new Error("Server name must match ^[a-zA-Z0-9_.-]{1,100}$");
  const file = readMcpFile();
  const prev = file.mcpServers[name];
  const type = config.type === "http" || config.type === "sse" ? config.type : "stdio";
  const merged: McpServerConfig = { ...prev, ...config };
  if (prev && prev.type !== type) {
    for (const key of transportKeys(prev.type || "stdio")) {
      if (!transportKeys(type).includes(key)) delete merged[key];
    }
  }
  for (const key of transportKeys(type)) {
    const v = merged[key];
    if (Array.isArray(v) && v.length === 0) delete merged[key];
    else if (v && typeof v === "object" && Object.keys(v).length === 0) delete merged[key];
    else if (v === "") delete merged[key];
  }
  file.mcpServers[name] = merged;
  // An explicitly saved server is no longer denylisted.
  file.disabledServers = (file.disabledServers || []).filter((n) => n !== name);
  writeMcpFile(file);
  clearProbeCache();
  return listMcpServers();
}

export async function removeMcpServer(name: string): Promise<McpState> {
  const file = readMcpFile();
  delete file.mcpServers[name];
  file.disabledServers = (file.disabledServers || []).filter((n) => n !== name);
  file.enabledServers = (file.enabledServers || []).filter((n) => n !== name);
  writeMcpFile(file);
  clearProbeCache();
  return listMcpServers();
}

/**
 * Toggle a server on/off. Defined servers flip their `enabled` flag. Names not
 * defined in mcpServers (discovered from other sources) are managed through the
 * disabledServers denylist / enabledServers allowlist: enabling removes from
 * the denylist AND adds to the allowlist (so the toggle overrides a source
 * `enabled:false` and keeps the server visible), disabling does the reverse.
 */
export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<McpState> {
  const file = readMcpFile();
  const denied = new Set(file.disabledServers || []);
  const forced = new Set(file.enabledServers || []);
  const defined = !!file.mcpServers[name];
  if (defined) {
    const next = { ...file.mcpServers[name] };
    if (enabled) delete next.enabled;
    else next.enabled = false;
    file.mcpServers[name] = next;
  }
  if (enabled) {
    denied.delete(name);
    if (!defined) forced.add(name); // discovered: allowlist overrides source enabled:false
  } else {
    denied.add(name);
    forced.delete(name);
  }
  file.disabledServers = [...denied];
  file.enabledServers = [...forced];
  writeMcpFile(file);
  clearProbeCache();
  return listMcpServers();
}

/** Replace the disabled/enabled server name lists (for discovered servers). */
export async function setMcpLists(disabledServers: string[], enabledServers: string[]): Promise<McpState> {
  const file = readMcpFile();
  file.disabledServers = [...new Set(disabledServers.filter((x: unknown) => typeof x === "string" && x))];
  file.enabledServers = [...new Set(enabledServers.filter((x: unknown) => typeof x === "string" && x))];
  writeMcpFile(file);
  clearProbeCache();
  return listMcpServers();
}
