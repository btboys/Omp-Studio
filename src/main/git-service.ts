import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as tls from "node:tls";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { readLightweightRoleModel } from "./models-service";
import { runOmpCli } from "./plugins";
import { getAgentDir } from "./session-store";

const execFileAsync = promisify(execFile);

/**
 * Git operations for the sidebar Git panel. Everything shells out to the
 * system `git` (the app's projects are plain working copies); parsing is kept
 * to `git status --porcelain -z -b` (v1, stable output, repo-root-relative
 * paths) and a delimited `git log` format. All handlers degrade to
 * `{ repo: false }` / `{ ok: false, error }` instead of throwing so the
 * renderer can render empty states without try/catch gymnastics.
 */

export interface GitFileEntry {
  path: string;
  /** porcelain letter: M A D R C U */
  status: string;
}

export interface GitStatusResult {
  repo: boolean;
  /** repository root (absolute); file paths are relative to it */
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  short: string;
  author: string;
  rel: string;
  refs: string;
  subject: string;
}

export interface GitOpResult {
  ok: boolean;
  error?: string;
  output?: string;
}

const EMPTY_STATUS: GitStatusResult = {
  repo: false,
  root: null,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
};

function run(cwd: string, args: string[], timeout = 10000): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile("git", ["-C", cwd, ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
  return promise;
}

function opError(stderr: string, fallback: string): string {
  const text = stderr.trim();
  return text || fallback;
}

/** One-line result for mutating operations: ok flag plus git's own message. */
async function op(cwd: string, args: string[], timeout = 15000): Promise<GitOpResult> {
  const r = await run(cwd, args, timeout);
  if (r.code === 0) return { ok: true, output: (r.stdout + r.stderr).trim() };
  return { ok: false, error: opError(r.stderr, `git ${args[0]} failed (${r.code})`) };
}

/**
 * Parse `git status --porcelain -z -b -uall`. With -z every record — the
 * `## branch…` header included — is NUL-terminated, so a record starting
 * with '#' is the branch header; the rest are `XY <path>` entries, and
 * rename/copy entries consume a second NUL record carrying the source path.
 */
function parseStatus(root: string | null, out: string): GitStatusResult {
  const res: GitStatusResult = { ...EMPTY_STATUS, repo: true, root, staged: [], unstaged: [], untracked: [] };
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    if (rec.startsWith("#")) {
      if (!rec.startsWith("## ")) continue;
      const head = rec.slice(3);
      const noCommits = head.match(/^No commits yet on (.+)$/);
      if (noCommits) res.branch = noCommits[1];
      else if (!head.startsWith("HEAD (no branch)")) {
        const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?$/);
        if (m) {
          res.branch = m[1] || null;
          res.upstream = m[2] || null;
          res.ahead = m[3] ? Number(m[3]) : 0;
          res.behind = m[4] ? Number(m[4]) : 0;
        }
      }
      continue;
    }
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const path = rec.slice(3);
    if (x === "?" && y === "?") {
      res.untracked.push(path);
      continue;
    }
    if (x === "!" && y === "!") continue;
    if (x === "R" || x === "C" || y === "R" || y === "C") i++; // skip rename source record
    if (x !== " " && x !== "?") res.staged.push({ path, status: x });
    if (y !== " " && y !== "?") res.unstaged.push({ path, status: y });
  }
  return res;
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  if (!cwd || typeof cwd !== "string") return { ...EMPTY_STATUS };
  const top = await run(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ...EMPTY_STATUS };
  const root = top.stdout.trim() || null;
  const r = await run(cwd, ["status", "--porcelain", "-z", "-b", "-uall"]);
  if (r.code !== 0) return { ...EMPTY_STATUS };
  return parseStatus(root, r.stdout);
}

export async function gitBranches(cwd: string): Promise<string[]> {
  const r = await run(cwd, ["branch", "--format=%(refname:short)"]);
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const LOG_SEP = "\x1f";
const LOG_END = "\x1e";

export interface GitLogOpts {
  limit?: number;
  /** git date expression, e.g. "3 days ago" — only commits since this time */
  since?: string;
  /** case-insensitive literal search over commit messages */
  query?: string;
  /** skip the N newest matching commits (pagination past the default window) */
  skip?: number;
}

export async function gitLog(cwd: string, opts: GitLogOpts = {}): Promise<GitLogEntry[]> {
  const args = [
    "log",
    "-n",
    String(opts.limit ?? 50),
    "--decorate=short",
    "--date=relative",
    `--format=%H${LOG_SEP}%h${LOG_SEP}%an${LOG_SEP}%ar${LOG_SEP}%D${LOG_SEP}%s${LOG_END}`,
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.query) args.push("--grep=" + opts.query, "-i", "-F");
  if (opts.skip) args.push("--skip=" + String(opts.skip));
  const r = await run(cwd, args);
  if (r.code !== 0) return []; // covers repos with no commits yet
  const out: GitLogEntry[] = [];
  for (const rec of r.stdout.split(LOG_END)) {
    const parts = rec.split(LOG_SEP);
    if (parts.length < 6) continue;
    out.push({
      hash: parts[0].trim(),
      short: parts[1],
      author: parts[2],
      rel: parts[3],
      refs: parts[4],
      subject: parts[5],
    });
  }
  return out;
}

export const gitStage = (cwd: string, paths: string[]) => (paths.length ? op(cwd, ["add", "--", ...paths]) : Promise.resolve({ ok: true } as GitOpResult));
export const gitUnstage = (cwd: string, paths: string[]) =>
  paths.length ? op(cwd, ["reset", "-q", "--", ...paths]) : Promise.resolve({ ok: true } as GitOpResult);
export const gitStageAll = (cwd: string) => op(cwd, ["add", "-A"]);
export const gitUnstageAll = (cwd: string) => op(cwd, ["reset", "-q"]);

/** Tracked paths are restored from the index; untracked paths are deleted. */
export async function gitDiscard(cwd: string, tracked: string[], untracked: string[]): Promise<GitOpResult> {
  if (tracked.length) {
    const r = await op(cwd, ["checkout", "--", ...tracked]);
    if (!r.ok) return r;
  }
  if (untracked.length) {
    const r = await op(cwd, ["clean", "-f", "--", ...untracked]);
    if (!r.ok) return r;
  }
  return { ok: true };
}

export const gitCommit = (cwd: string, message: string) => op(cwd, ["commit", "-m", message]);
export const gitCheckout = (cwd: string, branch: string) => op(cwd, ["checkout", branch]);
export const gitPull = (cwd: string) => op(cwd, ["pull"], 120000);
export const gitPush = (cwd: string) => op(cwd, ["push"], 120000);

/**
 * Create a linked worktree: `git worktree add -b <branch> <path>`. The branch
 * must not exist yet (git's own error surfaces through GitOpResult). The
 * resolved absolute path is returned so the renderer can open the new
 * checkout as a project.
 */
export async function gitWorktreeAdd(
  cwd: string,
  branch: string,
  path: string,
): Promise<GitOpResult & { path?: string }> {
  const b = (branch || "").trim();
  const p = (path || "").trim();
  if (!b || !p) return { ok: false, error: "branch and path are required" };
  const r = await op(cwd, ["worktree", "add", "-b", b, p], 30000);
  if (!r.ok) return r;
  return { ...r, path: isAbsolute(p) ? p : join(cwd, p) };
}

export type FileDiffResult = {
  ok: boolean;
  diff: string;
  /** true when the file is untracked, or the repo has no commits yet */
  newFile: boolean;
  error?: string;
};

const DIFF_MAX_CHARS = 1_000_000;
const NEW_FILE_MAX_LINES = 2000;

function truncateDiff(diff: string): string {
  if (diff.length > DIFF_MAX_CHARS) return diff.slice(0, DIFF_MAX_CHARS) + "\n…(diff 已截断)\n";
  return diff;
}

/**
 * Build a `git diff`-shaped output for a file git refuses to diff: untracked
 * files and files in a repo with no commits yet report no HEAD version, so the
 * whole file reads as additions. Returns "" for binary/unreadable files (the
 * caller still knows it is a new file via the newFile flag).
 */
function synthesizeNewFileDiff(filePath: string): string {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  if (text.slice(0, 8192).includes("\0")) return "";
  const all = text.split(/\r?\n/);
  const truncated = all.length > NEW_FILE_MAX_LINES;
  const lines = truncated ? all.slice(0, NEW_FILE_MAX_LINES) : all;
  if (lines[lines.length - 1] === "") lines.pop();
  const rel = filePath.replace(/\\/g, "/");
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
  const omitted = truncated ? `\n…(剩余 ${all.length - NEW_FILE_MAX_LINES} 行已省略)\n` : "";
  return header + lines.map((line) => `+${line}`).join("\n") + omitted;
}

/**
 * Unified diff of one file against HEAD — i.e. what the agent changed since
 * the last commit. Untracked files and commit-less repos get a synthesized
 * new-file diff instead of git's silent empty output. Always resolves (no
 * throw); callers render ok:false as an empty/error state.
 */
export async function gitFileDiff(cwd: string, filePath: string): Promise<FileDiffResult> {
  if (!cwd || typeof cwd !== "string" || !filePath || typeof filePath !== "string") {
    return { ok: false, diff: "", newFile: false, error: "invalid arguments" };
  }
  const top = await run(cwd, ["rev-parse", "--show-toplevel"], 3000);
  if (top.code !== 0) {
    return { ok: false, diff: "", newFile: false, error: top.stderr.trim() || "not a git repository" };
  }
  const head = await run(cwd, ["rev-parse", "--verify", "HEAD"], 3000);
  if (head.code !== 0) {
    // Git repo without commits yet: the whole tree counts as new.
    return { ok: true, diff: synthesizeNewFileDiff(filePath), newFile: true };
  }
  const r = await run(cwd, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", filePath], 8000);
  if (r.code !== 0) {
    return { ok: false, diff: "", newFile: false, error: r.stderr.trim() || `git diff failed (${r.code})` };
  }
  if (r.stdout.trim()) return { ok: true, diff: truncateDiff(r.stdout), newFile: false };
  // No output vs HEAD: unchanged, or untracked (git diff omits untracked files).
  const untracked = await run(cwd, ["ls-files", "--others", "--exclude-standard", "--", filePath], 5000);
  if (untracked.code === 0 && untracked.stdout.trim()) {
    return { ok: true, diff: synthesizeNewFileDiff(filePath), newFile: true };
  }
  return { ok: true, diff: "", newFile: false };
}

const DIFF_LIMIT = 4000;

type ChatEndpoint = { provider: string; model: string; url: string; key: string; omitTemperature?: boolean };

/** Known OpenAI-compatible chat endpoints used for cheap one-shot generation. */
const PROVIDER_CHAT: Record<string, { url: string; envKeys: string[]; omitTemperature?: boolean }> = {
  // kimi-code is usually OAuth in agent.db; env keys are rare but checked first
  // so Windows hosts without sqlite3 can still hit the fast path when set.
  "kimi-code": {
    url: "https://api.kimi.com/coding/v1/chat/completions",
    envKeys: ["KIMI_CODE_API_KEY"],
    omitTemperature: true,
  },
  deepseek: { url: "https://api.deepseek.com/chat/completions", envKeys: ["DEEPSEEK_API_KEY"] },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", envKeys: ["OPENROUTER_API_KEY"] },
  moonshot: { url: "https://api.moonshot.ai/v1/chat/completions", envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"] },
};

/** Cached sqlite3 CLI probe: undefined=unprobed, null=missing. */
let sqlite3Bin: string | null | undefined;

async function resolveSqlite3(): Promise<string | null> {
  if (sqlite3Bin !== undefined) return sqlite3Bin;
  const candidates = process.platform === "win32" ? ["sqlite3.exe", "sqlite3"] : ["sqlite3"];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ["-version"], { timeout: 2000, windowsHide: true });
      sqlite3Bin = bin;
      return bin;
    } catch {
      // try next
    }
  }
  sqlite3Bin = null;
  console.log(
    "[git] sqlite3 CLI not found on PATH; cannot read ~/.omp/agent/agent.db for OAuth keys. " +
      "Direct AI commit messages will use env API keys only (DEEPSEEK_API_KEY / OPENROUTER_API_KEY / KIMI_*).",
  );
  return null;
}

function proxyUrl(): string | null {
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    null
  );
}

/** Prefer Electron net.fetch (system/PAC proxy) when no env proxy is set. */
function electronFetch(): typeof fetch | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require("electron") as typeof import("electron");
    if (typeof net?.fetch === "function") return net.fetch.bind(net) as typeof fetch;
  } catch {
    // not in electron / unavailable
  }
  return null;
}

/**
 * POST JSON with proxy awareness:
 * - Electron net.fetch first (system/PAC + env proxies via Chromium)
 * - else HTTPS_PROXY/HTTP_PROXY → CONNECT+TLS tunnel via node:http/tls
 * - else global fetch
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  // Prefer Electron net.fetch whenever available: Chromium's stack honors
  // system/PAC proxy and commonly HTTPS_PROXY/HTTP_PROXY. Only fall through
  // to a hand-rolled CONNECT tunnel outside Electron.
  const eFetch = electronFetch();
  if (eFetch) {
    const res = await eFetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  }

  const proxy = proxyUrl();
  if (!proxy) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  }

  const target = new URL(url);
  const proxyParsed = new URL(proxy);
  const payload = Buffer.from(body);
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const timer = setTimeout(() => {
    reject(new Error(`proxy request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const settle = (fn: () => void) => {
    clearTimeout(timer);
    try {
      fn();
    } catch (e) {
      reject(e);
    }
  };

  const onResponse = (res: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    res.on("end", () =>
      settle(() => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") })),
    );
    res.on("error", (e) => settle(() => reject(e)));
  };

  const reqHeaders: http.OutgoingHttpHeaders = {
    ...headers,
    Host: target.host,
    "Content-Length": payload.length,
    Connection: "close",
  };
  if (proxyParsed.username || proxyParsed.password) {
    const auth = Buffer.from(
      `${decodeURIComponent(proxyParsed.username)}:${decodeURIComponent(proxyParsed.password)}`,
    ).toString("base64");
    reqHeaders["Proxy-Authorization"] = `Basic ${auth}`;
  }

  if (target.protocol === "https:") {
    // HTTPS via HTTP CONNECT tunnel.
    const connectReq = http.request({
      host: proxyParsed.hostname,
      port: Number(proxyParsed.port || (proxyParsed.protocol === "https:" ? 443 : 80)),
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        Host: `${target.hostname}:${target.port || 443}`,
        ...(reqHeaders["Proxy-Authorization"]
          ? { "Proxy-Authorization": reqHeaders["Proxy-Authorization"] as string }
          : {}),
      },
    });
    connectReq.setTimeout(timeoutMs);
    connectReq.on("connect", (res, socket) => {
      if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
        settle(() => reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`)));
        socket.destroy();
        return;
      }
      // Wrap the CONNECT TCP socket in TLS ourselves, then issue a plain
      // HTTP/1.1 request over that secure stream (https.request would TLS
      // again if handed a raw socket via createConnection).
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
      });
      tlsSocket.setTimeout(timeoutMs);
      tlsSocket.on("error", (e) => settle(() => reject(e)));
      tlsSocket.on("timeout", () => settle(() => reject(new Error("proxy TLS timed out"))));
      tlsSocket.once("secureConnect", () => {
        const tlsReq = http.request(
          {
            createConnection: () => tlsSocket as unknown as import("node:net").Socket,
            host: target.hostname,
            port: Number(target.port || 443),
            path: `${target.pathname}${target.search}`,
            method: "POST",
            headers: { ...headers, Host: target.host, "Content-Length": payload.length, Connection: "close" },
          },
          onResponse,
        );
        tlsReq.on("error", (e) => settle(() => reject(e)));
        tlsReq.write(payload);
        tlsReq.end();
      });
    });
    connectReq.on("error", (e) => settle(() => reject(e)));
    connectReq.end();
  } else {
    // Plain HTTP through proxy (absolute-form request).
    const req = http.request(
      {
        host: proxyParsed.hostname,
        port: Number(proxyParsed.port || 80),
        method: "POST",
        path: url,
        headers: reqHeaders,
      },
      onResponse,
    );
    req.on("error", (e) => settle(() => reject(e)));
    req.write(payload);
    req.end();
  }

  return promise;
}

async function readProviderKey(provider: string): Promise<string | null> {
  const meta = PROVIDER_CHAT[provider];
  if (!meta) return null;
  for (const env of meta.envKeys) {
    const v = process.env[env]?.trim();
    if (v) return v;
  }
  // Electron's Node build has no node:sqlite; shell out to system sqlite3
  // against omp's agent.db (oauth access / api_key blobs). Missing CLI is
  // common on Windows — log once and fall through to env-only providers.
  const dbPath = join(getAgentDir(), "agent.db");
  if (!existsSync(dbPath)) return null;
  const bin = await resolveSqlite3();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        dbPath,
        "SELECT data FROM auth_credentials WHERE provider = " +
          JSON.stringify(provider) +
          " AND disabled_cause IS NULL LIMIT 1;",
      ],
      { timeout: 3000, windowsHide: true },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const key = data.key || data.access || data.apiKey || data.token;
    return typeof key === "string" && key ? key : null;
  } catch (e: any) {
    console.log(`[git] sqlite3 read failed for ${provider}: ${e?.message || e}`);
    return null;
  }
}

export async function chatCandidates(): Promise<ChatEndpoint[]> {
  const out: ChatEndpoint[] = [];
  const seen = new Set<string>();
  const push = async (provider: string, model: string) => {
    const meta = PROVIDER_CHAT[provider];
    if (!meta) return;
    const key = await readProviderKey(provider);
    if (!key) return;
    const id = `${provider}/${model}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ provider, model, url: meta.url, key, omitTemperature: meta.omitTemperature });
  };

  // Prefer the user's lightweight role (smol/advisor) when we can speak its
  // OpenAI-compatible API directly — avoids omp's ~10s+ cold start.
  const role = readLightweightRoleModel();
  const sqlite = await resolveSqlite3();
  if (role) {
    const [provider, model] = role.split("/");
    if (provider && model) {
      const hasEnv = (PROVIDER_CHAT[provider]?.envKeys || []).some((k) => process.env[k]?.trim());
      if (hasEnv || sqlite) await push(provider, model);
      else
        console.log(
          `[git] skipping role model ${provider}/${model} for direct path (needs agent.db, sqlite3 missing)`,
        );
    }
  }
  // Env-backed fast fallbacks — these still work on Windows without sqlite3.
  await push("deepseek", "deepseek-chat");
  await push("openrouter", "deepseek/deepseek-chat");
  await push("moonshot", "kimi-k2-turbo-preview");
  if (sqlite) await push("kimi-code", "kimi-k2.5");
  return out;
}

export async function chatCompletion(endpoint: ChatEndpoint, userPrompt: string, opts?: {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string | null> {
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: [
      {
        role: "system",
        content:
          opts?.system ??
          "You write git commit messages. Reply with ONLY the commit message (Conventional Commits). No quotes, no markdown fence, no explanation. Subject <= 72 chars.",
      },
      { role: "user", content: userPrompt },
    ],
    max_tokens: opts?.maxTokens ?? 120,
  };
  if (!endpoint.omitTemperature) body.temperature = opts?.temperature ?? 0.2;
  const { status, text: raw } = await postJson(
    endpoint.url,
    {
      Authorization: `Bearer ${endpoint.key}`,
      "Content-Type": "application/json",
    },
    JSON.stringify(body),
    20000,
  );
  if (status < 200 || status >= 300) {
    throw new Error(`${endpoint.provider} HTTP ${status}: ${raw.slice(0, 160)}`);
  }
  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  return text || null;
}

function cleanMessage(text: string): string {
  return text
    .replace(/^```(?:\w+)?\n?|```$/g, "")
    .trim()
    .split("\n")
    .slice(0, 3)
    .join("\n");
}

/**
 * One-shot AI commit message. Prefers a direct OpenAI-compatible HTTP call
 * against the user's lightweight role / available provider credentials
 * (~1–4s). Falls back to `omp -p` only when no direct endpoint works.
 */
export async function gitGenerateMessage(cwd: string): Promise<GitOpResult> {
  const staged = await run(cwd, ["diff", "--cached", "--stat=200"]);
  let diff = "";
  if (staged.code === 0 && staged.stdout.trim()) {
    diff = (await run(cwd, ["diff", "--cached"])).stdout;
  } else {
    const head = await run(cwd, ["diff", "HEAD"]);
    diff = head.code === 0 ? head.stdout : (await run(cwd, ["diff"])).stdout;
  }
  if (!diff.trim()) {
    // Nothing to diff yet (e.g. unborn HEAD with only untracked files) — at
    // least name the files so the model has something to work with.
    const st = await gitStatus(cwd);
    const names = [...st.staged.map((f) => f.path), ...st.unstaged.map((f) => f.path), ...st.untracked];
    if (!names.length) return { ok: false, error: "没有可提交的更改" };
    diff = "新增文件:\n" + names.join("\n");
  }
  if (diff.length > DIFF_LIMIT) diff = diff.slice(0, DIFF_LIMIT) + "\n…(diff 已截断)";
  const recent = (await run(cwd, ["log", "-n", "5", "--format=%s"])).stdout.trim();
  const prompt =
    "根据下面的 git diff 生成一条 commit message。要求:遵循 Conventional Commits;" +
    (recent ? `风格对齐仓库最近提交:\n${recent}\n` : "") +
    "只输出 message 本身(可含 emoji 前缀若仓库有此惯例),不要解释、不要引号、不要代码块。主题行尽量不超过 72 字符。\n\ndiff:\n" +
    diff;

  const started = Date.now();
  const candidates = await chatCandidates();
  if (!candidates.length) {
    console.log("[git] no direct chat endpoints available; falling back to omp CLI");
  }
  for (const endpoint of candidates) {
    try {
      const text = await chatCompletion(endpoint, prompt);
      if (!text) continue;
      const output = cleanMessage(text);
      console.log(
        `[git] generateMessage via=${endpoint.provider}/${endpoint.model} ms=${Date.now() - started} proxy=${proxyUrl() ? "env" : "system/direct"} out=${output.length}b`,
      );
      return { ok: true, output };
    } catch (e: any) {
      console.log(`[git] generateMessage direct ${endpoint.provider}/${endpoint.model} failed: ${e?.message || e}`);
    }
  }

  // Fallback: omp CLI one-shot. Slow (cold start ~10s+) but works for any
  // configured role/model, including non-OpenAI transports like cursor.
  const args = [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-skills",
    "--no-extensions",
    "--no-lsp",
    "--thinking",
    "off",
  ];
  const fastModel = readLightweightRoleModel();
  if (fastModel) args.push("--model", fastModel);
  args.push(prompt);
  const r = await runOmpCli(args, undefined, 60000, cwd);
  const text = cleanMessage(r.stdout);
  console.log(
    `[git] generateMessage via=omp exit=${r.code} ms=${Date.now() - started} stdout=${r.stdout.length}b stderr<<${r.stderr}>>`,
  );
  if (r.code !== 0 || !text) {
    return {
      ok: false,
      error: r.stderr.trim()
        ? "AI 生成失败:" + r.stderr.trim().split("\n").pop()
        : "AI 生成超时或不可用,请重试",
    };
  }
  return { ok: true, output: text };
}
