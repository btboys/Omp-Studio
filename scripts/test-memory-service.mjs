import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Self-contained check for the memory manager (src/main/memory-service.ts).
 *
 * Builds a throwaway Mnemopi-shaped bank (working_memory + episodic_memory +
 * FTS5 indexes with sync triggers) in a temp agent dir, then exercises
 * list/search/add/update/delete through the real service module. Skips when
 * the system sqlite3 CLI is missing (the service shells out to it — Electron's
 * main runs Node 20, which has no node:sqlite).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
} catch {
  console.log("sqlite3 CLI not found on PATH; skipping memory service tests");
  process.exit(0);
}

const SCHEMA = `
CREATE TABLE working_memory (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, embed_text TEXT, source TEXT,
  timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5,
  metadata_json TEXT, veracity TEXT DEFAULT 'unknown', memory_type TEXT DEFAULT 'unknown',
  consolidated_at TEXT, recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP,
  valid_until TIMESTAMP, superseded_by TEXT, scope TEXT DEFAULT 'global',
  author_id TEXT, author_type TEXT, channel_id TEXT, trust_tier TEXT DEFAULT 'STATED',
  validator TEXT, validated_at TIMESTAMP, validation_count INTEGER DEFAULT 0,
  event_date TEXT, event_date_precision TEXT DEFAULT 'unknown', temporal_tags TEXT DEFAULT '[]',
  corrected_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE episodic_memory (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, content TEXT NOT NULL,
  source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5,
  metadata_json TEXT, summary_of TEXT DEFAULT '', veracity TEXT DEFAULT 'unknown',
  tier INTEGER DEFAULT 1, degraded_at TEXT, memory_type TEXT DEFAULT 'unknown',
  binary_vector BLOB, recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP,
  valid_until TIMESTAMP, superseded_by TEXT, scope TEXT DEFAULT 'global',
  author_id TEXT, author_type TEXT, channel_id TEXT, trust_tier TEXT DEFAULT 'STATED',
  validator TEXT, validated_at TIMESTAMP, validation_count INTEGER DEFAULT 0,
  event_date TEXT, event_date_precision TEXT DEFAULT 'unknown', temporal_tags TEXT DEFAULT '[]',
  corrected_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE fts_working USING fts5(id UNINDEXED, content);
CREATE VIRTUAL TABLE fts_episodes USING fts5(content, content='episodic_memory', content_rowid='rowid');
-- Trigger definitions mirror the real Mnemopi bank (internal-content FTS for
-- working_memory — deletes via DELETE FROM fts_working, no rowid on insert;
-- external-content FTS for episodic_memory — 'delete' command + rowid).
CREATE TRIGGER wm_ai AFTER INSERT ON working_memory BEGIN
  INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
END;
CREATE TRIGGER wm_ad AFTER DELETE ON working_memory BEGIN
  DELETE FROM fts_working WHERE id = old.id;
END;
CREATE TRIGGER wm_au AFTER UPDATE OF content, embed_text ON working_memory BEGIN
  DELETE FROM fts_working WHERE id = old.id;
  INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
END;
CREATE TRIGGER em_ai AFTER INSERT ON episodic_memory BEGIN
  INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER em_ad AFTER DELETE ON episodic_memory BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER em_au AFTER UPDATE ON episodic_memory BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;
`;

const agentDir = mkdtempSync(join(tmpdir(), "omp-memtest-"));
const bankId = "testproj-abc12345";
const bankDir = join(agentDir, "memories", "mnemopi", "banks", bankId);
mkdirSync(bankDir, { recursive: true });
const dbPath = join(bankDir, "mnemopi.db");

execFileSync(
  "sqlite3",
  [dbPath],
  {
    input:
      SCHEMA +
      `
INSERT INTO working_memory (id, content, source, timestamp, importance, memory_type, scope)
VALUES ('f1', 'Omp Studio 夜间模式架构要点', 'test', '2026-08-01T00:00:00.000Z', 0.8, 'fact', 'bank');
INSERT INTO working_memory (id, content, source, timestamp, importance, memory_type, scope)
VALUES ('f2', 'build 命令是 npm run build', 'test', '2026-08-02T00:00:00.000Z', 0.5, 'fact', 'bank');
INSERT INTO episodic_memory (id, content, source, timestamp, importance, memory_type)
VALUES ('e1', '一次关于夜间模式的对话片段', 'test', '2026-08-03T00:00:00.000Z', 0.6, 'episode');
`,
  },
);

const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

// memory-service imports local TS with extensionless paths, which Node's type
// stripping cannot resolve; bundle it (esbuild is already a dev dependency)
// and load the bundle from a data: URL.
const bundled = await build({
  entryPoints: [join(repoRoot, "src/main/memory-service.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const service = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

try {
  // ---- banks ---------------------------------------------------------------
  const { banks, sqliteAvailable } = await service.listMemoryBanks();
  assert.equal(sqliteAvailable, true);
  const bank = banks.find((b) => b.id === bankId);
  assert.ok(bank, "fixture bank is listed");
  assert.equal(bank.name, "testproj", "random suffix stripped from display name");
  assert.equal(bank.working, 2, "fact count");
  assert.equal(bank.episodes, 1, "episode count");

  // ---- list + ordering (newest first) --------------------------------------
  const facts = await service.listMemories(bankId, { table: "working" });
  assert.equal(facts.total, 2);
  assert.equal(facts.rows.length, 2);
  assert.equal(facts.rows[0].id, "f2", "facts ordered newest first");
  const episodes = await service.listMemories(bankId, { table: "episodes" });
  assert.equal(episodes.total, 1);
  assert.equal(episodes.rows[0].table, "episodes");

  // ---- search: English via FTS, Chinese via LIKE fallback -------------------
  assert.equal((await service.listMemories(bankId, { table: "working", q: "npm run" })).total, 1);
  const zh = await service.listMemories(bankId, { table: "working", q: "夜间模式" });
  assert.equal(zh.total, 1, "CJK query hits via LIKE fallback");
  assert.equal((await service.listMemories(bankId, { table: "episodes", q: "对话片段" })).total, 1);

  // ---- add: FTS stays in sync via trigger -----------------------------------
  const added = await service.addMemory(bankId, { content: "独有标记XYZ 的记忆", importance: 0.9, type: "fact" });
  assert.ok(added, "add returns a new id");
  assert.equal((await service.listMemories(bankId, { table: "working" })).total, 3);
  assert.equal((await service.listMemories(bankId, { table: "working", q: "独有标记XYZ" })).total, 1, "added memory is searchable");
  assert.equal((await service.listMemoryBanks()).banks.find((b) => b.id === bankId).working, 3, "bank count refreshes");

  // ---- pagination (plain list) ----------------------------------------------
  const page1 = await service.listMemories(bankId, { table: "working", limit: 2 });
  const page2 = await service.listMemories(bankId, { table: "working", limit: 2, offset: 2 });
  assert.equal(page1.total, 3, "plain list total is independent of page");
  assert.equal(page1.rows.length, 2);
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.rows[0].id, "f1", "offset pages past the newest rows");
  assert.notEqual(page1.rows[0].id, page2.rows[0].id, "pages do not overlap");

  // ---- pagination (search) --------------------------------------------------
  for (let i = 1; i <= 3; i++) {
    await service.addMemory(bankId, { content: `分页测试标签 ${i}`, importance: 0.5, type: "fact" });
  }
  const sp1 = await service.listMemories(bankId, { table: "working", q: "分页测试标签", limit: 2 });
  const sp2 = await service.listMemories(bankId, { table: "working", q: "分页测试标签", limit: 2, offset: 2 });
  assert.equal(sp1.total, 3, "search total counts all merged hits");
  assert.equal(sp1.rows.length, 2);
  assert.equal(sp2.rows.length, 1);
  assert.ok(sp2.rows[0].content.includes("分页测试标签"), "search offset reaches the remaining hit");
  const sp1Ids = new Set(sp1.rows.map((r) => r.id));
  assert.ok(!sp1Ids.has(sp2.rows[0].id), "search pages do not overlap");
  for (let i = 1; i <= 3; i++) {
    await service.deleteMemory(bankId, "working", (await service.listMemories(bankId, { table: "working", q: `分页测试标签 ${i}` })).rows[0].id);
  }
  assert.equal((await service.listMemories(bankId, { table: "working" })).total, 3, "pagination fixtures cleaned up");

  // ---- get: full content for the edit path ----------------------------------
  const full = await service.getMemory(bankId, "working", added);
  assert.equal(full.content, "独有标记XYZ 的记忆");

  // ---- update: content + importance, FTS re-synced ---------------------------
  await service.updateMemory(bankId, { table: "working", id: added, content: "独有标记ABC 的记忆", importance: 0.4 });
  const updated = await service.getMemory(bankId, "working", added);
  assert.equal(updated.content, "独有标记ABC 的记忆");
  assert.equal(updated.importance, 0.4);
  assert.equal((await service.listMemories(bankId, { table: "working", q: "独有标记ABC" })).total, 1);
  assert.equal((await service.listMemories(bankId, { table: "working", q: "独有标记XYZ" })).total, 0, "old content no longer matches");

  // ---- delete: gone from list and search -------------------------------------
  await service.deleteMemory(bankId, "working", added);
  assert.equal((await service.listMemories(bankId, { table: "working" })).total, 2);
  assert.equal((await service.listMemories(bankId, { table: "working", q: "独有标记ABC" })).total, 0);

  // ---- guards ----------------------------------------------------------------
  await assert.rejects(() => service.listMemories("../etc", { table: "working" }), /invalid bank id/);
  await assert.rejects(() => service.addMemory(bankId, { content: "   ", importance: 0.5, type: "fact" }), /empty/);
  await assert.rejects(() => service.updateMemory(bankId, { table: "working", id: "nope", content: "x" }), /not found/);
  await assert.rejects(() => service.deleteMemory(bankId, "episodes", "999999"), /not found/);

  console.log("memory service tests passed");
} finally {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
}
