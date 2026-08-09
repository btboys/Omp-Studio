import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Zero-dependency reader for omp's session store (~/.omp/agent/sessions).
 *
 * We intentionally do NOT import the pi SDK here: the desktop app should keep
 * working even if pi's internal modules shift, and reading JSONL directly keeps
 * the main process bundle tiny. The directory name is a lossy encoding of the
 * cwd, so we group projects by the real `cwd` found in each file's header.
 */

export interface ThreadSummary {
  /** Absolute path to the .jsonl file; also the stable thread id. */
  file: string;
  /** Session id from the header. */
  id: string;
  /** Display name from the last session_info entry, else first user prompt. */
  title: string;
  /** First user prompt text, truncated (used as the list subtitle). */
  preview: string;
  /** Last activity time (ms epoch). */
  updatedAt: number;
  /** Conversation turns: user prompts plus agent final replies. */
  messageCount: number;
}

export interface ProjectSummary {
  /** Real working directory, as stored in session headers. */
  cwd: string;
  /** Folder name shown in the sidebar. */
  name: string;
  threads: ThreadSummary[];
}

export function getAgentDir(): string {
  // omp's agent dir: PI_CODING_AGENT_DIR, falling back to the legacy PI_AGENT_DIR
  // override and the default ~/.omp/agent.
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".omp", "agent");
}

export function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

/** omp stores the model as "provider/modelId" in model_change entries. */
function splitModel(value: string): { provider: string; id: string } {
  const idx = value.indexOf("/");
  if (idx > 0 && idx < value.length - 1) return { provider: value.slice(0, idx), id: value.slice(idx + 1) };
  return { provider: "", id: value };
}

/** Stream a file line-by-line using only `\n` as delimiter (JSONL-safe). */
function forEachLine(file: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buf = "";
    const stream = createReadStream(file, { encoding: "utf8" as BufferEncoding });
    stream.on("data", (chunk: string | Buffer) => {
      buf += decoder.write(Buffer.from(chunk));
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length) onLine(line);
      }
    });
    stream.on("end", () => {
      buf += decoder.end();
      if (buf.length) {
        if (buf.endsWith("\r")) buf = buf.slice(0, -1);
        if (buf.length) onLine(buf);
      }
      resolve();
    });
    stream.on("error", reject);
  });
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

interface ParsedSkillPrompt {
  name: string;
  userMessage?: string;
}

function parseSkillPrompt(text: string): ParsedSkillPrompt | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return { name: match[1], userMessage: match[2]?.trim() || undefined };
}

function displayUserPrompt(text: string): string {
  const skill = parseSkillPrompt(text);
  return skill ? skill.userMessage || `skill: ${skill.name}` : text;
}

function displayThreadTitle(sessionName: string, promptText: string): string {
  const name = sessionName.trim();
  const prompt = displayUserPrompt(promptText).trim();
  return name && !/^<skill(?:\s|>)/i.test(name) ? name : prompt;
}

/** True when an assistant message is a final user-facing reply: it triggers no
 * further tool calls and is not a failed model call. Intermediate model calls
 * (which contain toolCall blocks) are excluded so the thread count reflects
 * user prompts plus agent final replies only. */
function isFinalAssistantReply(m: any): boolean {
  if (!m || m.role !== "assistant") return false;
  if (m.stopReason === "error") return false;
  return !(Array.isArray(m.content) && m.content.some((b: any) => b && b.type === "toolCall"));
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

async function readThreadSummary(file: string): Promise<{ summary: ThreadSummary; cwd: string } | null> {
  let id = "";
  let cwd = "";
  let name = "";
  let preview = "";
  let messageCount = 0;
  let lastTs = 0;
  try {
    await forEachLine(file, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      if (e.type === "session") {
        id = e.id || id;
        cwd = e.cwd || cwd;
        const t = Date.parse(e.timestamp || "");
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
        return;
      }
      if (e.type === "session_info" && typeof e.name === "string" && e.name.trim()) {
        name = e.name.trim();
      }
      // omp (v3) stores the mutable title in a first-line "title" slot and in
      // "title_change" entries instead of "session_info".
      if (e.type === "title" && typeof e.title === "string" && e.title.trim()) {
        name = e.title.trim();
      }
      if (e.type === "title_change" && typeof e.title === "string" && e.title.trim()) {
        name = e.title.trim();
      }
      if (e.type === "message") {
        const m = e.message;
        if (m && m.role === "user") {
          messageCount++;
          if (!preview) preview = truncate(displayUserPrompt(textOfContent(m.content)), 90);
        } else if (isFinalAssistantReply(m)) {
          messageCount++;
        }
      }
      if (e.timestamp) {
        const t = Date.parse(e.timestamp);
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
      }
    });
  } catch {
    return null;
  }
  if (!id && !cwd) return null;
  if (!cwd) return null;
  let updatedAt = lastTs;
  try {
    const st = statSync(file);
    updatedAt = Math.max(updatedAt, st.mtimeMs);
  } catch {
    /* ignore */
  }
  const title = displayThreadTitle(name, preview) || "新会话";
  return { summary: { file, id, title, preview, updatedAt, messageCount }, cwd };
}

/** Full transcript + display metadata read straight from a session .jsonl,
 *  without booting a pi process. Lets the UI render a thread instantly on
 *  click; a live process is only needed later for interaction. The `messages`
 *  array holds the raw pi message objects (same shape as the `get_messages`
 *  RPC), so the renderer reuses one conversion path for disk and live data. */
export interface ThreadHistory {
  cwd: string | null;
  sessionName: string | null;
  /** Current model from the last model_change entry, if any. */
  model: { provider: string; id: string } | null;
  /** Current thinking level from the last thinking_level_change entry. */
  thinkingLevel: string | null;
  messages: any[];
}

export async function readThreadHistory(file: string): Promise<ThreadHistory> {
  let cwd: string | null = null;
  let sessionName: string | null = null;
  let model: { provider: string; id: string } | null = null;
  let thinkingLevel: string | null = null;
  const messages: any[] = [];
  await forEachLine(file, (line) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "session":
        if (e.cwd) cwd = e.cwd;
        break;
      case "session_info":
        if (typeof e.name === "string" && e.name.trim()) sessionName = e.name.trim();
        break;
      case "title":
      case "title_change":
        if (typeof e.title === "string" && e.title.trim()) sessionName = e.title.trim();
        break;
      case "message":
        if (e.message) messages.push(e.message);
        break;
      case "model_change":
        if (typeof e.model === "string" && e.model) model = splitModel(e.model);
        else if (e.provider && e.modelId) model = { provider: e.provider, id: e.modelId };
        break;
      case "thinking_level_change":
        if (typeof e.thinkingLevel === "string") thinkingLevel = e.thinkingLevel;
        break;
      default:
        break;
    }
  });
  return { cwd, sessionName, model, thinkingLevel, messages };
}

/**
 * Remove the last exchange from a session file: the final user prompt and
 * everything written after it (its assistant reply, tool results, …). The
 * file is truncated at the byte offset of that user message line, so history
 * before the exchange is untouched. Returns ok:false when there is nothing
 * to undo or the file cannot be written.
 */
/** True when a parsed session line is a user message entry. */
function isUserMessageLine(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  if (!("type" in e) || e.type !== "message") return false;
  if (!("message" in e)) return false;
  const m = e.message;
  return !!m && typeof m === "object" && "role" in m && m.role === "user";
}

export function undoLastTurn(file: string): { ok: boolean; message?: string } {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return { ok: false, message: "无法读取会话文件" };
  }
  let lineStart = 0;
  let lastUserOffset = -1;
  while (lineStart < buf.length) {
    const nl = buf.indexOf(0x0a, lineStart);
    const lineEnd = nl === -1 ? buf.length : nl;
    const line = buf.toString("utf8", lineStart, lineEnd).trim();
    if (line) {
      try {
        if (isUserMessageLine(JSON.parse(line))) lastUserOffset = lineStart;
      } catch {
        /* skip malformed lines */
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (lastUserOffset < 0) return { ok: false, message: "会话中没有可撤销的用户消息" };
  try {
    truncateSync(file, lastUserOffset);
  } catch (e) {
    return { ok: false, message: "写入失败：" + (e instanceof Error ? e.message : String(e)) };
  }
  return { ok: true };
}

export interface ThreadSearchHit {
  /** Absolute path to the .jsonl file; also the stable thread id. */
  file: string;
  /** Real working directory of the project. */
  cwd: string;
  /** Display name of the thread. */
  title: string;
  /** Folder name of the project. */
  projectName: string;
  /** Last activity time (ms epoch). */
  updatedAt: number;
  /** Conversation turns: user prompts plus agent final replies. */
  messageCount: number;
  /** A snippet of the first matched text, with surrounding context. */
  snippet: string;
  /** Total number of keyword matches in the thread (capped). */
  matchCount: number;
}

function makeSnippet(text: string, idx: number, qlen: number): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + qlen + 70);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

async function searchOneFile(file: string, q: string): Promise<ThreadSearchHit | null> {
  let cwd = "";
  let name = "";
  let preview = "";
  let messageCount = 0;
  let lastTs = 0;
  let matchCount = 0;
  let snippet = "";

  const checkText = (text: string) => {
    if (!text) return;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) return;
    while (idx !== -1 && matchCount < 999) {
      matchCount++;
      if (!snippet) snippet = makeSnippet(text, idx, q.length);
      idx = lower.indexOf(q, idx + q.length);
    }
  };

  try {
    await forEachLine(file, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      if (e.type === "session") {
        cwd = e.cwd || cwd;
        const t = Date.parse(e.timestamp || "");
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
        return;
      }
      if (e.type === "session_info" && typeof e.name === "string" && e.name.trim()) {
        name = e.name.trim();
      }
      // omp (v3) stores the mutable title in a first-line "title" slot and in
      // "title_change" entries instead of "session_info".
      if (e.type === "title" && typeof e.title === "string" && e.title.trim()) {
        name = e.title.trim();
      }
      if (e.type === "title_change" && typeof e.title === "string" && e.title.trim()) {
        name = e.title.trim();
      }
      if (e.type === "message") {
        const m = e.message;
        if (m) {
          const text = textOfContent(m.content);
          if (m.role === "user") {
            messageCount++;
            if (!preview) preview = truncate(displayUserPrompt(text), 90);
          } else if (isFinalAssistantReply(m)) {
            messageCount++;
          }
          if (m.role === "user" || m.role === "assistant") checkText(text);
        }
      }
      if (e.timestamp) {
        const t = Date.parse(e.timestamp);
        if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
      }
    });
  } catch {
    return null;
  }

  if (!cwd) return null;
  const title = displayThreadTitle(name, preview) || "新会话";
  if (title.toLowerCase().includes(q)) {
    if (!snippet) snippet = title;
    if (!matchCount) matchCount = 1;
  }
  if (!matchCount) return null;

  let updatedAt = lastTs;
  try {
    updatedAt = Math.max(updatedAt, statSync(file).mtimeMs);
  } catch {
    /* ignore */
  }

  return {
    file,
    cwd,
    title,
    projectName: basename(cwd) || cwd,
    updatedAt,
    messageCount,
    snippet,
    matchCount,
  };
}

/** Full-text search across every session's user/assistant text. */
export async function searchThreads(query: string, limit = 50): Promise<ThreadSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const root = getSessionsDir();
  if (!existsSync(root)) return [];

  const files: string[] = [];
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const d of dirs) {
      const dirPath = join(root, d);
      try {
        for (const f of readdirSync(dirPath)) if (f.endsWith(".jsonl")) files.push(join(dirPath, f));
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  const hits: ThreadSearchHit[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const hit = await searchOneFile(files[idx], q);
      if (hit) hits.push(hit);
    }
  }
  const concurrency = 8;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, worker));

  hits.sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt);
  return hits.slice(0, limit);
}

export interface TotalUsage {
  /** Sum of usage.totalTokens across every message in every session. */
  tokens: number;
  /** Sum of usage.cost.total across every message in every session. */
  cost: number;
  /** Number of session files scanned. */
  sessions: number;
}

async function sumUsageInFile(file: string): Promise<{ tokens: number; cost: number }> {
  let tokens = 0;
  let cost = 0;
  try {
    await forEachLine(file, (line) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      const u = e?.message?.usage;
      if (u && typeof u === "object") {
        if (typeof u.totalTokens === "number") tokens += u.totalTokens;
        const c = u.cost?.total;
        if (typeof c === "number") cost += c;
      }
    });
  } catch {
    /* ignore unreadable file */
  }
  return { tokens, cost };
}

/** Aggregate token/cost usage across every session file. */
export async function getTotalUsage(): Promise<TotalUsage> {
  const root = getSessionsDir();
  if (!existsSync(root)) return { tokens: 0, cost: 0, sessions: 0 };
  const files: string[] = [];
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const d of dirs) {
      try {
        for (const f of readdirSync(join(root, d))) if (f.endsWith(".jsonl")) files.push(join(root, d, f));
      } catch {
        continue;
      }
    }
  } catch {
    return { tokens: 0, cost: 0, sessions: 0 };
  }
  let tokens = 0;
  let cost = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const r = await sumUsageInFile(files[idx]);
      tokens += r.tokens;
      cost += r.cost;
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, files.length)) }, worker));
  return { tokens, cost, sessions: files.length };
}

/**
 * Permanently delete every session directory whose files belong to `cwd`.
 * The sessions dir name is a lossy encoding of the cwd, so each dir is probed
 * via its first jsonl file's real cwd header. Returns the number of dirs removed.
 */
export async function deleteProjectSessions(cwd: string): Promise<number> {
  const target = cwd.toLowerCase();
  const root = getSessionsDir();
  if (!existsSync(root)) return 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const d of dirs) {
    const dirPath = join(root, d);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const probe = await readThreadSummary(join(dirPath, files[0]));
    if (!probe || probe.cwd.toLowerCase() !== target) continue;
    try {
      rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      /* keep going; a locked dir should not block the rest */
    }
  }
  return removed;
}

/** Read every session file under the sessions dir, grouped by real cwd. */
export async function scanProjects(): Promise<ProjectSummary[]> {
  const root = getSessionsDir();
  if (!existsSync(root)) return [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const groups = new Map<string, ProjectSummary>();
  // light concurrency limit
  const queue: string[] = [];
  for (const d of dirs) {
    const dirPath = join(root, d);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) queue.push(join(dirPath, f));
  }

  const concurrency = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      const file = queue[idx];
      const read = await readThreadSummary(file);
      if (!read) continue;
      const { summary, cwd } = read;
      let group = groups.get(cwd);
      if (!group) {
        group = { cwd, name: basename(cwd) || cwd, threads: [] };
        groups.set(cwd, group);
      }
      group.threads.push(summary);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));

  const projects = [...groups.values()];
  for (const p of projects) p.threads.sort((a, b) => b.updatedAt - a.updatedAt);
  projects.sort((a, b) => {
    const la = a.threads[0]?.updatedAt ?? 0;
    const lb = b.threads[0]?.updatedAt ?? 0;
    return lb - la;
  });
  return projects;
}
