import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getConfig } from "./config";
import { resolvePiRuntime } from "./pi-bridge";
import { runOmpCli } from "./plugins";
import { getAgentDir } from "./session-store";

/**
 * Thin wrapper around omp's `auth-broker` command: interactive login/logout
 * for the OAuth/API-key providers omp ships with (Cursor, Claude, Codex,
 * Kimi Code, …). Credentials are persisted by omp itself into the agent
 * SQLite store (`~/.omp/agent/agent.db` → `auth_credentials`), which every
 * spawned omp process reads — no broker `serve` process is needed for local
 * use.
 *
 * Login is a long-running, interactive child: it prints the OAuth URL to
 * stdout, may prompt for a paste-code / API key on stdin, and only exits once
 * the callback lands. The renderer drives it through a small session object.
 */

export interface AuthProviderInfo {
  id: string;
  name: string;
}

export interface AuthLoginHandlers {
  /** One complete stdout/stderr line from the login process. */
  onLine: (line: string) => void;
  /** First `http(s)://` URL printed — open it in the browser. */
  onUrl: (url: string) => void;
  /** The process is waiting for a paste (authorization code / API key). */
  onAwaitingInput: () => void;
}

export interface AuthLoginSession {
  readonly providerId: string;
  /** Write an answer to the process's stdin prompt. */
  sendInput(text: string): void;
  /** Kill the process (user cancelled; window closing). */
  cancel(): void;
  /** Resolves when the child exits. */
  readonly done: Promise<{ code: number | null; ok: boolean; message: string }>;
}

/** `omp auth-broker list --json` — providers with an interactive login flow. */
export async function listAuthProviders(): Promise<AuthProviderInfo[]> {
  const res = await runOmpCli(["auth-broker", "list", "--json"]);
  if (res.code !== 0) {
    const detail = (res.stdout + res.stderr).trim() || `omp auth-broker list exited with code ${res.code}`;
    throw new Error(detail);
  }
  const parsed = JSON.parse(res.stdout.replace(/^\uFEFF/, "").trim() || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p: unknown): p is AuthProviderInfo => !!p && typeof (p as AuthProviderInfo).id === "string");
}

/** `omp auth-broker logout <provider>` — deletes the stored credential. */
export async function logoutAuthProvider(providerId: string): Promise<{ ok: boolean; output: string }> {
  const res = await runOmpCli(["auth-broker", "logout", providerId]);
  if (res.code !== 0) {
    return { ok: false, output: (res.stdout + res.stderr).trim() || `logout exited with code ${res.code}` };
  }
  return { ok: true, output: (res.stdout + res.stderr).trim() || `Logged out of ${providerId}` };
}

/**
 * omp prompts are written to stdout via `readline.question`, i.e. as a
 * trailing partial line that ends with `: `. Informational output is always
 * newline-terminated, so "alive child + current partial line ends with ':'
 * (or '?')" is a reliable "waiting for paste" signal.
 */
function looksLikePrompt(partial: string): boolean {
  const t = partial.trimEnd();
  return t.length > 0 && (t.endsWith(":") || t.endsWith("?"));
}

let activeSession: AuthLoginSession | null = null;

export function getActiveAuthSession(): AuthLoginSession | null {
  return activeSession;
}

/**
 * Start `omp auth-broker login <provider>` as a streamed child. Only one
 * login may run at a time (the UI owns a single modal). Throws when a login
 * is already in flight.
 */
export function startAuthLogin(providerId: string, handlers: AuthLoginHandlers): AuthLoginSession {
  if (activeSession) {
    throw new Error(`Login for ${activeSession.providerId} is already in progress`);
  }

  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; ok: boolean; message: string }>();
  let proc: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;

  // omp's login loop ignores SIGTERM while waiting for the OAuth callback;
  // escalate so a cancelled login never leaks a process.
  const killProc = () => {
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    const t = setTimeout(() => {
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 2000);
    proc.once("exit", () => clearTimeout(t));
  };

  const session: AuthLoginSession = {
    providerId,
    sendInput(text: string) {
      if (proc && !proc.stdin.destroyed) {
        proc.stdin.write(text + "\n");
      }
    },
    cancel() {
      // The spawn is async (runtime resolution); remember the intent so a
      // cancel that lands before spawn still kills the child once it exists.
      cancelled = true;
      killProc();
    },
    done: promise,
  };
  activeSession = session;

  void (async () => {
    try {
      const rt = await resolvePiRuntime(getConfig().ompBinPath);
      proc = spawn(rt.bin, ["auth-broker", "login", providerId], {
        cwd: getAgentDir(),
        env: { ...process.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (cancelled) killProc();

      let stdout = "";
      let stderr = "";
      let urlSent = false;
      let lastPrompt = "";
      let promptTimer: ReturnType<typeof setTimeout> | null = null;

      /**
       * A real paste prompt blocks the process on stdin, so stdout stays
       * still. A chunk-boundary partial line is completed within a few ms, so
       * wait 400ms and only fire if the tail is still an unanswered prompt.
       */
      const schedulePromptCheck = (partial: string) => {
        if (promptTimer) {
          clearTimeout(promptTimer);
          promptTimer = null;
        }
        promptTimer = setTimeout(() => {
          promptTimer = null;
          const cur = stdout.split(/\r?\n/).pop() ?? "";
          if (proc && proc.exitCode === null && cur === partial && looksLikePrompt(partial) && partial !== lastPrompt) {
            lastPrompt = partial;
            handlers.onAwaitingInput();
          }
        }, 400);
      };

      const feed = (chunk: string, isStderr: boolean) => {
        const buf = isStderr ? stderr : stdout;
        if (isStderr) stderr = buf + chunk;
        else stdout = buf + chunk;
        const text = isStderr ? stderr : stdout;
        const lines = text.split(/\r?\n/);
        const partial = lines.pop() ?? ""; // rest after last newline
        for (const line of lines) {
          const l = line.trim();
          if (!l) continue;
          handlers.onLine(l);
          if (!urlSent && /^https?:\/\//.test(l)) {
            urlSent = true;
            handlers.onUrl(l);
          }
        }
        if (partial && looksLikePrompt(partial)) schedulePromptCheck(partial);
        else if (promptTimer) {
          clearTimeout(promptTimer);
          promptTimer = null;
        }
      };
      proc.stdout.on("data", (d: Buffer) => feed(d.toString("utf8"), false));
      proc.stderr.on("data", (d: Buffer) => feed(d.toString("utf8"), true));

      proc.on("error", (err) => {
        if (activeSession === session) activeSession = null;
        reject(err);
      });
      proc.on("exit", (code) => {
        if (promptTimer) {
          clearTimeout(promptTimer);
          promptTimer = null;
        }
        if (activeSession === session) activeSession = null;
        const all = (stdout + "\n" + stderr).trim();
        const tail = all.split(/\r?\n/).filter(Boolean).pop() || "";
        resolve({ code, ok: code === 0, message: code === 0 ? tail || `Logged in to ${providerId}` : tail || `login exited with code ${code}` });
      });
    } catch (e) {
      if (activeSession === session) activeSession = null;
      reject(e as Error);
    }
  })();

  return session;
}

/** Kill any in-flight login child (app shutdown). */
export function stopAllAuthSessions(): void {
  if (activeSession) {
    activeSession.cancel();
    activeSession = null;
  }
}
