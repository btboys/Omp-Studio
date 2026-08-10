import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./session-store";
import { resolveSqlite3, runSqlite, sq } from "./sqlite3-cli";
import type { MemoryBank, MemoryRow } from "../renderer/src/lib/types";

/**
 * Memory management for Mnemopi banks: ~/.omp/agent/memories/mnemopi/banks/
 * <project-id>/mnemopi.db. Each bank is a SQLite file with working_memory
 * (facts) and episodic_memory (episodes) tables; FTS5 indexes are maintained
 * by triggers inside the DB, so plain INSERT/UPDATE/DELETE keep search
 * consistent. All access goes through the system sqlite3 CLI (Electron's main
 * runs Node 20, no node:sqlite); missing CLI degrades to bank listing only.
 */

const LIST_CONTENT_LEN = 10000;

function banksDir(): string {
  return join(getAgentDir(), "memories", "mnemopi", "banks");
}

/** Directory name → display name: strip the trailing random suffix (`proj-abc12345` → `proj`). */
function displayName(dir: string): string {
  const m = /^(.*)-[a-z0-9]{6,14}$/.exec(dir);
  return m ? m[1] : dir;
}

function bankDbPath(bankId: string): string {
  // IPC is a trust boundary: bankId arrives from the renderer.
  if (!/^[A-Za-z0-9._-]+$/.test(bankId)) throw new Error("invalid bank id");
  const p = join(banksDir(), bankId, "mnemopi.db");
  if (!existsSync(p)) throw new Error(`memory bank not found: ${bankId}`);
  return p;
}

async function query<T>(dbPath: string, sql: string): Promise<T[]> {
  const out = await runSqlite(dbPath, sql);
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed) as T[];
  } catch {
    throw new Error("sqlite3 output was not valid JSON (is the CLI too old for .mode json?)");
  }
}

export async function isSqliteAvailable(): Promise<boolean> {
  return (await resolveSqlite3()) !== null;
}

export async function listMemoryBanks(): Promise<{ banks: MemoryBank[]; sqliteAvailable: boolean }> {
  const sqlite = await isSqliteAvailable();
  const dir = banksDir();
  if (!existsSync(dir)) return { banks: [], sqliteAvailable: sqlite };
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const banks: MemoryBank[] = [];
  for (const name of names) {
    const dbPath = join(dir, name, "mnemopi.db");
    if (!existsSync(dbPath)) continue;
    let working = -1;
    let episodes = -1;
    if (sqlite) {
      try {
        const rows = await query<{ w: number; e: number }>(
          dbPath,
          "SELECT (SELECT count(*) FROM working_memory) AS w, (SELECT count(*) FROM episodic_memory) AS e;",
        );
        working = rows[0]?.w ?? 0;
        episodes = rows[0]?.e ?? 0;
      } catch (err) {
        console.log(`[memory] count failed for ${name}: ${(err as Error).message}`);
      }
    }
    banks.push({ id: name, name: displayName(name), working, episodes });
  }
  return { banks, sqliteAvailable: sqlite };
}

interface RowShape {
  id: string;
  content: string;
  importance: number;
  timestamp: string;
  memoryType: string;
  source: string | null;
}

const LEN = LIST_CONTENT_LEN;
const WORKING_COLS = "w.id, substr(w.content, 1, " + LEN + ") AS content, w.importance, w.timestamp, w.memory_type AS memoryType, w.source";
const EPISODE_COLS = "e.rowid AS id, substr(e.content, 1, " + LEN + ") AS content, e.importance, e.timestamp, e.memory_type AS memoryType, e.source";
// Single-table variants (no aliases needed, avoids ambiguity in FTS joins).
const WORKING_PLAIN = "id, substr(content, 1, " + LEN + ") AS content, importance, timestamp, memory_type AS memoryType, source";
const EPISODE_PLAIN = "rowid AS id, substr(content, 1, " + LEN + ") AS content, importance, timestamp, memory_type AS memoryType, source";

/** Wrap a user query as an FTS5 phrase (doubled quotes escape literal quotes). */
function ftsPhrase(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"';
}

export async function listMemories(
  bankId: string,
  opts: { table: "working" | "episodes"; q?: string; limit?: number },
): Promise<MemoryRow[]> {
  const dbPath = bankDbPath(bankId);
  const table = opts.table === "episodes" ? "episodes" : "working";
  const lim = Math.max(1, Math.min(opts.limit ?? 300, 1000));
  const q = (opts.q ?? "").trim();
  let rows: RowShape[];
  if (q) {
    // FTS5's default tokenizer treats a CJK run as one token, so phrase
    // search misses Chinese queries; merge FTS hits with a substring LIKE
    // fallback (deduped, FTS first) to cover both.
    const match = sq(ftsPhrase(q));
    const like = sq("%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
    const esc = " ESCAPE '\\'";
    const ftsRows = await query<RowShape>(
      dbPath,
      table === "episodes"
        ? `SELECT ${EPISODE_COLS} FROM fts_episodes f JOIN episodic_memory e ON e.rowid = f.rowid WHERE fts_episodes MATCH ${match} ORDER BY e.timestamp DESC, e.rowid DESC LIMIT ${lim};`
        : `SELECT ${WORKING_COLS} FROM fts_working f JOIN working_memory w ON w.id = f.id WHERE fts_working MATCH ${match} ORDER BY w.timestamp DESC, w.rowid DESC LIMIT ${lim};`,
    );
    const subRows = await query<RowShape>(
      dbPath,
      table === "episodes"
        ? `SELECT ${EPISODE_PLAIN} FROM episodic_memory WHERE content LIKE ${like}${esc} ORDER BY timestamp DESC, rowid DESC LIMIT ${lim};`
        : `SELECT ${WORKING_PLAIN} FROM working_memory WHERE content LIKE ${like}${esc} ORDER BY timestamp DESC, rowid DESC LIMIT ${lim};`,
    );
    rows = [];
    const seen = new Set<string>();
    for (const r of [...ftsRows, ...subRows]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
      if (rows.length >= lim) break;
    }
  } else {
    rows = await query<RowShape>(
      dbPath,
      table === "episodes"
        ? `SELECT ${EPISODE_PLAIN} FROM episodic_memory ORDER BY timestamp DESC, rowid DESC LIMIT ${lim};`
        : `SELECT ${WORKING_PLAIN} FROM working_memory ORDER BY timestamp DESC, rowid DESC LIMIT ${lim};`,
    );
  }
  return rows.map((r) => ({ ...r, table }));
}

export async function getMemory(bankId: string, table: "working" | "episodes", id: string): Promise<MemoryRow> {
  const dbPath = bankDbPath(bankId);
  const rows = await query<RowShape>(
    dbPath,
    table === "episodes"
      ? `SELECT rowid AS id, content, importance, timestamp, memory_type AS memoryType, source FROM episodic_memory WHERE rowid = ${sq(id)};`
      : `SELECT id, content, importance, timestamp, memory_type AS memoryType, source FROM working_memory WHERE id = ${sq(id)};`,
  );
  if (!rows[0]) throw new Error(`memory not found: ${id}`);
  return { ...rows[0], table };
}

export async function addMemory(
  bankId: string,
  input: { content: string; importance: number; type: string },
): Promise<string> {
  const dbPath = bankDbPath(bankId);
  const content = input.content.trim();
  if (!content) throw new Error("memory content is empty");
  const importance = Number.isFinite(input.importance) ? Math.max(0, Math.min(1, input.importance)) : 0.5;
  const type = /^[A-Za-z_-]{1,32}$/.test(input.type) ? input.type : "fact";
  const id = randomUUID();
  const now = new Date().toISOString();
  await runSqlite(
    dbPath,
    `INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, memory_type, scope, veracity)
     VALUES (${sq(id)}, ${sq(content)}, 'omp-studio', ${sq(now)}, 'default', ${importance}, ${sq(type)}, 'bank', 'STATED');`,
  );
  return id;
}

export async function updateMemory(
  bankId: string,
  input: { table: "working" | "episodes"; id: string; content?: string; importance?: number },
): Promise<void> {
  const dbPath = bankDbPath(bankId);
  const table = input.table === "episodes" ? "episodic_memory" : "working_memory";
  const sets: string[] = [];
  if (input.content !== undefined) {
    if (!input.content.trim()) throw new Error("memory content is empty");
    sets.push(`content = ${sq(input.content)}`);
  }
  if (input.importance !== undefined) {
    const v = Number.isFinite(input.importance) ? Math.max(0, Math.min(1, input.importance)) : 0.5;
    sets.push(`importance = ${v}`);
  }
  if (!sets.length) return;
  const key = table === "working_memory" ? "id" : "rowid";
  // RETURNING doubles as the affected-row check (works alongside mnemopi's
  // FTS-sync triggers — verified against the real bank schema).
  const rows = await query<{ id: string }>(dbPath, `UPDATE ${table} SET ${sets.join(", ")} WHERE ${key} = ${sq(input.id)} RETURNING ${key};`);
  if (!rows.length) throw new Error(`memory not found: ${input.id}`);
}

export async function deleteMemory(bankId: string, table: "working" | "episodes", id: string): Promise<void> {
  const dbPath = bankDbPath(bankId);
  const tbl = table === "episodes" ? "episodic_memory" : "working_memory";
  const key = tbl === "working_memory" ? "id" : "rowid";
  const rows = await query<{ id: string }>(dbPath, `DELETE FROM ${tbl} WHERE ${key} = ${sq(id)} RETURNING ${key};`);
  if (!rows.length) throw new Error(`memory not found: ${id}`);
}

export function getBanksDir(): string {
  return banksDir();
}
