import { execFile, spawn } from "node:child_process";

/**
 * SQLite access for the main process. Electron's main process runs Node 20,
 * which has no `node:sqlite`, so we shell out to the system `sqlite3` CLI.
 * Missing CLI is common on Windows — callers must degrade gracefully.
 */

/** Cached sqlite3 CLI probe: undefined=unprobed, null=missing. */
let sqlite3Bin: string | null | undefined;

export async function resolveSqlite3(): Promise<string | null> {
  if (sqlite3Bin !== undefined) return sqlite3Bin;
  const candidates = process.platform === "win32" ? ["sqlite3.exe", "sqlite3"] : ["sqlite3"];
  for (const bin of candidates) {
    try {
      await execFile(bin, ["-version"], { timeout: 2000, windowsHide: true });
      sqlite3Bin = bin;
      return bin;
    } catch {
      // try next
    }
  }
  sqlite3Bin = null;
  console.log("[sqlite3] CLI not found on PATH; database-backed features are unavailable.");
  return null;
}

/** Reset the cached probe (used by tests). */
export function resetSqlite3Probe(): void {
  sqlite3Bin = undefined;
}

/**
 * Run SQL against a SQLite file via the system CLI.
 *
 * SQL is piped through stdin (argv length is limited, memory content is not)
 * and output is emitted as JSON via `.mode json`, so a single SELECT yields a
 * JSON array. A busy timeout guards against WAL lock contention while agent
 * processes hold the database. Throws with the CLI's stderr on failure.
 */
export async function runSqlite(dbPath: string, sql: string, timeoutMs = 8000): Promise<string> {
  const bin = await resolveSqlite3();
  if (!bin) throw new Error("sqlite3 CLI not available");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [dbPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `sqlite3 exited with code ${code}`));
    });
    child.stdin.write(".timeout 5000\n");
    child.stdin.write(".mode json\n");
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** Escape a value for use as a SQLite string literal. */
export function sq(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
