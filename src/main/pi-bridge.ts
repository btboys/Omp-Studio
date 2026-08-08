import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensureRuntimePackage, getActiveRuntimeRoot, getRuntimePackageManifest, ompBinaryFileName, runtimePathsForRoot } from "./runtime-package";

// Mirror omp's RPC transport limits (packages/coding-agent/src/modes/rpc/rpc-frame.ts):
// one JSONL frame caps at 1 MiB; protocol v2 reassembles chunked frames up to 64 MiB.
const MAX_RPC_FRAME_BYTES = 1024 * 1024;
const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/**
 * PiBridge
 * --------
 * Owns a single `omp --mode rpc-ui` subprocess and translates between omp's
 * JSONL protocol (the same NDJSON RPC protocol pi exposed; see omp docs/sdk.md)
 * and the Electron IPC layer.
 *
 * omp is a fork of pi. The RPC command/event surface is a superset of what the
 * app used with pi, with these differences handled here:
 *   - spawn the self-contained `omp` binary directly (no node + cli.js pair)
 *   - `--mode rpc-ui` (not `rpc`): makes `ctx.hasUI` true so the sandbox gate
 *     can surface approval dialogs as `extension_ui_request` frames
 *   - `get_commands`      → `get_available_commands`
 *   - `get_entries`       → gone; branching messages come from
 *                           `get_branch_messages` (user messages only)
 *   - `get_available_thinking_levels` → gone; the level set is a fixed enum
 *   - no `--name` / `--skill` flags
 *   - no `agent_settled` event: omp ends turns with `agent_end` carrying
 *     `isTerminal`. The bridge synthesizes `agent_settled` after a terminal
 *     `agent_end` so the renderer store and the automation scheduler work
 *     unchanged.
 */

export interface ResolvedRuntime {
  bin: string;
}

/** Where the resolved runtime came from, in resolution-priority order. */
export type RuntimeKind = "override" | "userData" | "bundled" | "system";

let resolvedRuntime: ResolvedRuntime | null = null;
let resolvedKind: RuntimeKind | null = null;
let resolvingRuntime: Promise<ResolvedRuntime> | null = null;

/**
 * Locate the bundled omp binary. New releases ship it as an embedded runtime
 * extracted under userData; the legacy lookup remains for developer builds.
 *
 * Search order:
 *  1. PI_BUNDLED_DIR env var (set by the app at startup for dev convenience)
 *  2. process.resourcesPath/bundled (Electron packaged app)
 */
export function getBundledRuntime(): ResolvedRuntime | null {
  const candidates: string[] = [];
  if (process.env.PI_BUNDLED_DIR) candidates.push(process.env.PI_BUNDLED_DIR);
  try {
    const rp = (process as any).resourcesPath as string | undefined;
    if (rp) candidates.push(join(rp, "bundled"));
  } catch { /* ignore */ }

  const name = ompBinaryFileName();
  for (const dir of candidates) {
    const bin = join(dir, name);
    if (existsSync(bin)) return { bin };
  }
  return null;
}

/** Split PATH into directories without spawning anything (cross-platform). */
function pathDirs(): string[] {
  const raw = process.env.PATH || process.env.Path || process.env.path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(sep)) {
    const d = part.trim().replace(/^"+|"+$/g, "");
    if (!d) continue;
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function firstExistingFile(dirs: string[], names: string[]): string | null {
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* ignore unreadable dir entry */
      }
    }
  }
  return null;
}

/** Locate the `omp` binary on PATH (dev mode / user-installed omp). */
function locateOmpBinary(): string | null {
  const names = process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp.bat", "omp"] : ["omp"];
  return firstExistingFile(pathDirs(), names);
}

/**
 * Locate the app-managed runtime under `<userData>/runtime/versions/<version>`.
 * It takes precedence over the legacy bundled copy: an update must win over
 * the version shipped in the app.
 */
function locateUserDataRuntime(): ResolvedRuntime | null {
  const root = getActiveRuntimeRoot();
  if (!root) return null;
  const packaged = runtimePathsForRoot(root);
  return packaged || null;
}

/**
 * Resolve the omp binary once, caching the result. Pure-JS PATH scanning so it
 * works on Windows without spawning `where`/`which` (which are .cmd wrappers
 * and would fail under shell:false).
 *
 * Priority: explicit override → app-updated userData runtime → bundled → PATH.
 * @param binOverride optional explicit omp binary path from app config.
 */
export async function resolvePiRuntime(binOverride?: string): Promise<ResolvedRuntime> {
  if (resolvedRuntime) return resolvedRuntime;
  if (resolvingRuntime) return resolvingRuntime;
  resolvingRuntime = (async () => {
    // 1. Explicit user override (Settings > omp binary path)
    if (binOverride && binOverride.trim()) {
      const bin = binOverride.trim();
      if (!existsSync(bin)) throw new Error(`Configured omp binary path does not exist: ${bin}`);
      resolvedRuntime = { bin };
      resolvedKind = "override";
      return resolvedRuntime;
    }

    // 2. App-updated runtime under userData (written by the core updater)
    const userData = locateUserDataRuntime();
    if (userData) {
      resolvedRuntime = userData;
      resolvedKind = "userData";
      return resolvedRuntime;
    }

    // 3. First launch of a new packaged app: extract and verify the embedded
    // standalone runtime described by resources/runtime-manifest.json. The
    // promise is shared so the warm bridge and renderer diagnostics never
    // install it twice.
    let runtimeBootstrapError: unknown = null;
    try {
      const installedRoot = await ensureRuntimePackage();
      const installed = installedRoot ? runtimePathsForRoot(installedRoot) : null;
      if (installed) {
        resolvedRuntime = installed;
        resolvedKind = "userData";
        return resolvedRuntime;
      }
    } catch (error) {
      runtimeBootstrapError = error;
      // eslint-disable-next-line no-console
      console.error("[omp] standalone runtime bootstrap failed:", (error as Error)?.message || String(error));
    }

    // 4. Legacy bundled runtime (old packaged app or dev with resources/bundled/)
    const bundled = getBundledRuntime();
    if (bundled) {
      resolvedRuntime = bundled;
      resolvedKind = "bundled";
      return resolvedRuntime;
    }

    // In a packaged release, a failed standalone bootstrap must not silently
    // fall through to a global PATH install. That would make the app-managed
    // update button operate on a different omp installation than the app uses.
    if (runtimeBootstrapError && getRuntimePackageManifest()) {
      throw new Error(`omp runtime package could not be installed: ${(runtimeBootstrapError as Error)?.message || String(runtimeBootstrapError)}`);
    }

    // 5. Fall back to PATH scanning (dev mode or user-installed omp).
    const bin = locateOmpBinary();
    if (!bin) {
      if (runtimeBootstrapError) {
        throw new Error(`omp runtime package could not be installed: ${(runtimeBootstrapError as Error)?.message || String(runtimeBootstrapError)}`);
      }
      throw new Error(
        "omp was not found. Install it (see https://omp.sh), or set a custom omp binary path in Settings.",
      );
    }
    resolvedRuntime = { bin };
    resolvedKind = "system";
    return resolvedRuntime;
  })().finally(() => {
    resolvingRuntime = null;
  });
  return resolvingRuntime;
}

/** Forget cached runtime so the next open re-resolves (e.g. after settings change or core update). */
export function resetPiRuntime(): void {
  resolvedRuntime = null;
  resolvedKind = null;
  resolvingRuntime = null;
}

/** Which source the cached runtime came from (null before first resolution). */
export function runtimeKind(): RuntimeKind | null {
  return resolvedKind;
}

/**
 * True when the resolved runtime is managed by the app itself (bundled copy or
 * an app-updated copy under userData) — i.e. `omp update` cannot update it and
 * the in-app core updater must be used instead. Only valid after resolution.
 */
export function isAppManagedRuntime(): boolean {
  return resolvedKind === "bundled" || resolvedKind === "userData";
}

/** Read the omp version from a resolved binary (`omp --version` → "17.2.9"). */
export function getOmpVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) resolve(null);
      else resolve((stdout.trim().split(/\r?\n/)[0] || "").replace(/^omp\//, "") || null);
    });
  });
}

/** The fixed set of thinking levels omp exposes (see its `--thinking` flag). */
export const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

/** Map an omp Model object to the renderer's ModelInfo shape. */
function toModelInfo(model: any): { provider: string; id: string; name?: string; contextWindow?: number; reasoning?: boolean; input?: string[] } | null {
  if (!model || typeof model !== "object") return null;
  const provider = model.provider && typeof model.provider === "object" ? model.provider.id : model.provider;
  const id = typeof model.id === "string" ? model.id : model.modelId;
  if (!provider || !id) return null;
  const out: any = { provider, id };
  if (typeof model.name === "string") out.name = model.name;
  if (typeof model.contextWindow === "number") out.contextWindow = model.contextWindow;
  if (typeof model.reasoning === "boolean") out.reasoning = model.reasoning;
  if (Array.isArray(model.input)) out.input = model.input;
  return out;
}

export interface PiBridgeOptions {
  cwd: string;
  ompBinPath?: string;
  /** Resume an existing session file; omit to create a fresh session. */
  sessionFile?: string;
  /** Absolute paths to extension files loaded for this run (e.g. the sandbox permission gate). */
  extensions?: string[];
  /** Per-thread gate mode file exposed to the gate extension as
   * PI_STUDIO_GATE_MODE_FILE so sandbox/full can be toggled without a restart. */
  gateModeFile?: string;
  onEvent: (event: unknown) => void;
  onExtUi: (request: ExtUiRequest) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string; expected?: boolean }) => void;
  onError?: (err: Error) => void;
}

export interface ExtUiRequest {
  id: string;
  method: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  command: string;
}

export class PiBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly opts: PiBridgeOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private stderrBuf = "";
  private started = false;
  private exited = false;
  /** True once stop() was called; the resulting exit is intentional, not a crash. */
  private stopRequested = false;
  /** Negotiated RPC protocol version; v2 splits >1 MiB frames into rpc_chunk lines. */
  private protocolVersion: 1 | 2 = 1;
  /** Resolves once the server's `ready` frame arrives (start() handshake). */
  private readyWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  /** In-flight protocol v2 chunk reassembly, keyed by chunkId. */
  private pendingChunks = new Map<string, { count: number; byteLength: number; received: Buffer[]; bytes: number; next: number }>();

  constructor(opts: PiBridgeOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const rt = await resolvePiRuntime(this.opts.ompBinPath);
    // rpc-ui (not rpc): extension UI dialogs (select/confirm/input/editor) are
    // emitted as `extension_ui_request` frames and ctx.hasUI is true, which the
    // sandbox gate requires to surface approval prompts.
    const args = ["--mode", "rpc-ui", "--no-title"];
    if (this.opts.sessionFile) args.push("--session", this.opts.sessionFile);
    for (const ext of this.opts.extensions || []) args.push("--extension", ext);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.opts.gateModeFile) env.PI_STUDIO_GATE_MODE_FILE = this.opts.gateModeFile;

    this.proc = spawn(rt.bin, args, {
      cwd: this.opts.cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutDecoder = new StringDecoder("utf8");
    let buf = "";
    this.proc.stdout.on("data", (chunk: Buffer) => {
      buf += stdoutDecoder.write(chunk);
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        this.handleLine(line);
      }
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
      if (this.stderrBuf.length > 64 * 1024) this.stderrBuf = this.stderrBuf.slice(-32 * 1024);
    });

    this.proc.on("error", (err) => {
      this.opts.onError?.(err);
      this.readyWaiter?.reject(err);
      this.readyWaiter = null;
      this.rejectAllPending(err);
    });

    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      // flush decoder
      buf += stdoutDecoder.end();
      if (buf.trim().length > 0) this.handleLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
      const stderr = this.stderrBuf.trim();
      const detail = stderr ? `: ${stderr.slice(-4000)}` : "";
      this.rejectAllPending(new Error(`omp process exited (code=${code}, signal=${signal})${detail}`));
      if (this.readyWaiter) {
        this.readyWaiter.reject(new Error(`omp process exited (code=${code}, signal=${signal}) before the RPC ready frame`));
        this.readyWaiter = null;
      }
      this.opts.onExit({ code, signal, stderr: this.stderrBuf, expected: this.stopRequested });
    });

    // Handshake: wait for the `ready` frame, then negotiate protocol v2 so
    // responses larger than the 1 MiB single-frame ceiling (e.g. get_messages
    // on a long session) arrive as chunked rpc_chunk frames instead of being
    // refused with "RPC response exceeded the transport limit".
    await new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    if (this.exited) throw new Error("omp process exited before the RPC ready frame");
    await this.negotiateProtocol();
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // not JSON; ignore stray output
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ready") {
      this.readyWaiter?.resolve();
      this.readyWaiter = null;
      return;
    }

    if (msg.type === "rpc_chunk") {
      const frame = this.feedChunk(msg);
      if (frame) this.handleFrame(frame);
      return;
    }

    this.handleFrame(msg);
  }

  /** Reassemble protocol v2 rpc_chunk lines into the original logical frame. */
  private feedChunk(msg: any): any | undefined {
    const { chunkId, index, count, byteLength, data } = msg;
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      index >= count ||
      byteLength < MAX_RPC_FRAME_BYTES ||
      byteLength > MAX_RPC_REASSEMBLED_BYTES
    ) {
      return undefined;
    }
    const bytes = Buffer.from(typeof data === "string" ? data : "", "base64");
    let pending = this.pendingChunks.get(chunkId);
    if (!pending) {
      pending = { count, byteLength, received: [], bytes: 0, next: 0 };
      this.pendingChunks.set(chunkId, pending);
    }
    if (pending.count !== count || pending.byteLength !== byteLength || pending.next !== index) {
      // Protocol violation: drop the whole sequence rather than mixing chunks.
      this.pendingChunks.delete(chunkId);
      return undefined;
    }
    pending.received.push(bytes);
    pending.bytes += bytes.byteLength;
    pending.next++;
    if (pending.next < pending.count) return undefined;
    this.pendingChunks.delete(chunkId);
    if (pending.bytes !== pending.byteLength) return undefined;
    try {
      return JSON.parse(Buffer.concat(pending.received).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  /** Route a complete (possibly reassembled) frame to its handler. */
  private handleFrame(msg: any): void {
    if (msg.type === "response") {
      const id = typeof msg.id === "string" ? msg.id : null;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.success === false) p.reject(new Error(msg.error || `${p.command} failed`));
        else p.resolve(msg.data);
      }
      return;
    }

    if (msg.type === "extension_ui_request") {
      this.opts.onExtUi(msg as ExtUiRequest);
      return;
    }

    // everything else is an agent event
    this.opts.onEvent(msg);

    // omp has no `agent_settled` event: a turn ends with `agent_end` where
    // `isTerminal !== false` (absent means terminal for older runtimes). The
    // renderer store and the automation scheduler wait on `agent_settled`, so
    // synthesize it after a terminal agent_end.
    if (msg.type === "agent_end" && msg.isTerminal !== false) {
      this.opts.onEvent({ type: "agent_settled" });
    }
  }

  /** Ask the server to switch to chunked protocol v2; stay on v1 on failure. */
  private async negotiateProtocol(): Promise<void> {
    try {
      const res: any = await this.send("negotiate_protocol", { protocolVersion: 2 });
      if (res?.protocolVersion === 2) this.protocolVersion = 2;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[omp] RPC v2 negotiation failed, staying on v1:", (err as Error)?.message || String(err));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
  }

  /** Send a command and resolve with its `data` payload. */
  send(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.exited) {
        reject(new Error("omp bridge is not running"));
        return;
      }
      const id = `r${++this.reqCounter}`;
      this.pending.set(id, { resolve, reject, command });
      const line = JSON.stringify({ id, type: command, ...payload }) + "\n";
      this.proc.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Reply to an extension UI dialog request (select/confirm/input/editor). */
  respondExtUi(id: string, payload: Record<string, unknown>): void {
    if (!this.proc || this.exited) return;
    this.proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n");
  }

  // ---- convenience wrappers -------------------------------------------------

  prompt(message: string, images?: unknown[]): Promise<unknown> {
    const payload: Record<string, unknown> = { message };
    if (images && images.length) payload.images = images;
    return this.send("prompt", payload);
  }
  steer(message: string, images?: unknown[]): Promise<unknown> {
    const payload: Record<string, unknown> = { message };
    if (images && images.length) payload.images = images;
    return this.send("steer", payload);
  }
  followUp(message: string, images?: unknown[]): Promise<unknown> {
    const payload: Record<string, unknown> = { message };
    if (images && images.length) payload.images = images;
    return this.send("follow_up", payload);
  }
  abort(): Promise<unknown> {
    return this.send("abort");
  }
  getState(): Promise<unknown> {
    return this.send("get_state");
  }
  getMessages(): Promise<unknown> {
    return this.send("get_messages");
  }
  /**
   * Branching messages for the fork UI. omp's `get_branch_messages` returns
   * user messages only (omp's `branch` command only accepts user entries), so
   * assistant replies get no branch anchor — Fork/Clone appear on user turns.
   */
  getBranchMessages(): Promise<{ messages: { entryId: string; role: "user"; text: string }[] }> {
    return this.send("get_branch_messages").then((res: any) => {
      const messages = Array.isArray(res?.messages) ? res.messages : [];
      return {
        messages: messages
          .filter((m: any) => m && typeof m.entryId === "string")
          .map((m: any) => ({ entryId: m.entryId, role: "user" as const, text: typeof m.text === "string" ? m.text : "" })),
      };
    });
  }
  /** Fork the session at a user-message entry id (omp `branch` RPC). */
  branchAt(entryId: string): Promise<unknown> {
    return this.send("branch", { entryId });
  }
  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.send("set_model", { provider, modelId });
  }
  getAvailableModels(): Promise<unknown> {
    return this.send("get_available_models").then((res: any) => {
      const models = Array.isArray(res?.models) ? res.models.map(toModelInfo).filter(Boolean) : [];
      return { models };
    });
  }
  refreshModels(): Promise<unknown> {
    // get_available_models awaits omp's background registry refresh itself.
    return this.getAvailableModels();
  }
  setThinkingLevel(level: string): Promise<unknown> {
    return this.send("set_thinking_level", { level });
  }
  getAvailableThinkingLevels(): Promise<unknown> {
    return Promise.resolve({ levels: [...OMP_THINKING_LEVELS] });
  }
  newSession(parentSession?: string): Promise<unknown> {
    return this.send("new_session", parentSession ? { parentSession } : {});
  }
  switchSession(sessionPath: string): Promise<unknown> {
    return this.send("switch_session", { sessionPath });
  }
  setSessionName(name: string): Promise<unknown> {
    return this.send("set_session_name", { name });
  }
  getCommands(): Promise<unknown> {
    return this.send("get_available_commands");
  }
  getSessionStats(): Promise<unknown> {
    return this.send("get_session_stats");
  }

  stop(): void {
    if (!this.proc || this.exited) return;
    this.stopRequested = true;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }

  get running(): boolean {
    return !!this.proc && !this.exited;
  }

  get cwd(): string {
    return this.opts.cwd;
  }
}
