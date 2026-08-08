import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

/**
 * Lazy file-tree listing for the sidebar "Files" tab. Only direct children are
 * returned; the renderer expands folders on demand.
 */

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "out",
  "dist",
  "dist-win",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface FileNode {
  name: string;
  /** Path relative to the project cwd, using forward slashes. */
  rel: string;
  abs: string;
  isDir: boolean;
  ext: string;
  size: number;
}

function assertInside(cwd: string, target: string): string {
  const c = resolve(cwd);
  const t = resolve(target);
  if (t !== c && !t.startsWith(c + sep)) {
    throw new Error("Path escapes project root");
  }
  return t;
}

export function listDir(cwd: string, rel?: string): FileNode[] {
  const base = rel && rel.length ? assertInside(cwd, join(cwd, rel)) : resolve(cwd);
  if (!existsSync(base)) return [];
  const st = statSync(base);
  if (!st.isDirectory()) return [];
  const entries = readdirSync(base, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith(".") && e.name !== ".env") {
      // hide dotfiles except .env; keep tree uncluttered
      if (e.name === ".gitignore" || e.name === ".editorconfig") {
        /* allow a couple of common ones */
      } else continue;
    }
    const abs = join(base, e.name);
    let size = 0;
    let isDir = e.isDirectory();
    try {
      const s = statSync(abs);
      size = s.size;
      isDir = s.isDirectory();
    } catch {
      /* skip unreadable */
      continue;
    }
    const relPath = (rel ? rel + "/" : "") + e.name;
    nodes.push({
      name: e.name,
      rel: relPath,
      abs,
      isDir,
      ext: isDir ? "" : extname(e.name).toLowerCase(),
      size,
    });
  }
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return nodes;
}

export function fileExists(abs: string): boolean {
  try {
    return existsSync(abs);
  } catch {
    return false;
  }
}

export function baseName(abs: string): string {
  return basename(abs);
}


function matchScore(rel: string, query: string): number {
  const lower = rel.toLowerCase();
  const name = lower.split("/").pop() || lower;
  if (!query) return 1;
  if (name === query) return 400;
  if (name.startsWith(query)) return 300;
  if (name.includes(query)) return 220;
  if (lower.includes("/" + query)) return 160;
  if (lower.includes(query)) return 120;
  // subsequence fuzzy only on basename, and only for short queries
  if (query.length >= 2 && query.length <= 4) {
    let i = 0;
    for (const ch of name) {
      if (ch === query[i]) i += 1;
      if (i >= query.length) return 50;
    }
  }
  return 0;
}

/**
 * Bounded recursive file search for composer `@` mentions.
 * Skips the same heavy dirs as the sidebar tree and ranks by basename/path match.
 */
export function searchProjectFiles(cwd: string, query: string, limit = 30): FileNode[] {
  const root = resolve(cwd);
  if (!existsSync(root)) return [];
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const q = String(query || "").trim().toLowerCase();
  const maxLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const maxVisit = 8000;
  const candidates: FileNode[] = [];
  let visited = 0;

  const walk = (dir: string, rel: string) => {
    if (visited >= maxVisit) return;
    // When querying, gather a larger pool then rank; when empty, stop early.
    if (!q && candidates.length >= maxLimit) return;
    if (q && candidates.length >= maxLimit * 8) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= maxVisit) return;
      if (IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env") {
        if (entry.name !== ".gitignore" && entry.name !== ".editorconfig") continue;
      }

      visited += 1;
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let size = 0;
      try {
        const st = statSync(abs);
        isDir = st.isDirectory();
        size = st.size;
      } catch {
        continue;
      }

      if (isDir) {
        walk(abs, relPath);
        continue;
      }

      if (!q || matchScore(relPath, q) > 0) {
        candidates.push({
          name: entry.name,
          rel: relPath,
          abs,
          isDir: false,
          ext: extname(entry.name).toLowerCase(),
          size,
        });
      }
    }
  };

  walk(root, "");

  if (!q) return candidates.slice(0, maxLimit);

  return candidates
    .map((node) => ({ node, score: matchScore(node.rel, q) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.rel.length - b.node.rel.length || a.node.rel.localeCompare(b.node.rel))
    .slice(0, maxLimit)
    .map((item) => item.node);
}
