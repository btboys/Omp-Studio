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
