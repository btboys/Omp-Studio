import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

/**
 * Reads a file and returns a renderer-friendly preview payload. Heavy parsing
 * (pdf/docx/xlsx) is done in the renderer with pdfjs / mammoth / sheetjs; here
 * we only classify by extension and return either text or base64 bytes.
 */

export type PreviewPayload = {
  name: string;
  ext: string;
  size: number;
  kind:
    | "text"
    | "markdown"
    | "html"
    | "image"
    | "docx"
    | "xlsx"
    | "pptx"
    | "unsupported"
    | "toobig"
    | "missing";
  mime?: string;
  text?: string;
  base64?: string;
  lang?: string;
  truncated?: boolean;
  message?: string;
  previewUrl?: string;
};

const TEXT_EXTS: Record<string, string> = {
  ".txt": "plaintext",
  ".log": "plaintext",
  ".json": "json",
  ".jsonc": "json",
  ".mdx": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".svg": "xml",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".vue": "xml",
  ".svelte": "xml",
  ".ini": "ini",
  ".env": "bash",
  ".gitignore": "bash",
  ".dockerfile": "dockerfile",
  ".makefile": "makefile",
  ".c": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".lua": "lua",
  ".r": "r",
  ".csv": "csv",
  ".tsv": "csv",
};

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdown"]);
const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};
// NOTE: PDF preview is intentionally not supported in this build (pdfjs-dist
// omitted to keep the bundle small). .pdf falls through to "unsupported".
const DOCX_EXTS = new Set([".docx"]);
const XLSX_EXTS = new Set([".xlsx", ".xls"]);
const PPTX_EXTS = new Set([".pptx"]);

const TEXT_MAX = 2_000_000; // 2 MB of text
const BIN_MAX = 40_000_000; // 40 MB binary

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function readPreview(absPath: string): PreviewPayload {
  const name = basename(absPath);
  const ext = extname(name).toLowerCase();
  const base = { name, ext, size: 0 } as PreviewPayload;

  if (!existsSync(absPath)) return { ...base, kind: "missing", message: "File not found" };

  let st;
  try {
    st = statSync(absPath);
  } catch (e: any) {
    return { ...base, kind: "missing", message: e?.message || "stat failed" };
  }
  if (st.isDirectory()) return { ...base, kind: "unsupported", message: "This is a folder" };
  base.size = st.size;

  // images
  if (ext in IMAGE_EXTS && ext !== ".svg") {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    const buf = readFileSync(absPath);
    return { ...base, kind: "image", mime: IMAGE_EXTS[ext], base64: buf.toString("base64") };
  }

  // docx / xlsx -> base64 for renderer-side parsing
  if (DOCX_EXTS.has(ext)) {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return {
      ...base,
      kind: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64: readFileSync(absPath).toString("base64"),
    };
  }
  if (XLSX_EXTS.has(ext)) {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return {
      ...base,
      kind: "xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: readFileSync(absPath).toString("base64"),
    };
  }
  if (PPTX_EXTS.has(ext)) {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return {
      ...base,
      kind: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      base64: readFileSync(absPath).toString("base64"),
    };
  }

  // markdown
  if (MARKDOWN_EXTS.has(ext)) {
    if (st.size > TEXT_MAX) {
      const buf = readFileSync(absPath, { encoding: "utf8" }).slice(0, TEXT_MAX);
      return { ...base, kind: "markdown", text: buf, truncated: true, lang: "markdown" };
    }
    return { ...base, kind: "markdown", text: readFileSync(absPath, "utf8"), lang: "markdown" };
  }

  // html (also svg-as-text fallback handled below)
  if (ext === ".html" || ext === ".htm") {
    if (st.size > TEXT_MAX) {
      const buf = readFileSync(absPath, { encoding: "utf8" }).slice(0, TEXT_MAX);
      return { ...base, kind: "html", text: buf, truncated: true, lang: "html" };
    }
    return { ...base, kind: "html", text: readFileSync(absPath, "utf8"), lang: "html" };
  }

  // svg: show as image by default (vector preview)
  if (ext === ".svg") {
    if (st.size > BIN_MAX) return { ...base, kind: "toobig" };
    return { ...base, kind: "image", mime: "image/svg+xml", base64: readFileSync(absPath).toString("base64") };
  }

  // known text
  if (ext in TEXT_EXTS) {
    const buf = readFileSync(absPath);
    if (looksBinary(buf)) return { ...base, kind: "unsupported", message: "Binary file" };
    let text = buf.toString("utf8");
    let truncated = false;
    if (text.length > TEXT_MAX) {
      text = text.slice(0, TEXT_MAX);
      truncated = true;
    }
    const lang = TEXT_EXTS[ext];
    if (lang === "csv") return { ...base, kind: "xlsx", text, lang: "csv", truncated };
    return { ...base, kind: "text", text, lang, truncated };
  }

  // unknown extension: try as text if small and not binary
  if (st.size <= TEXT_MAX) {
    const buf = readFileSync(absPath);
    if (!looksBinary(buf)) {
      return { ...base, kind: "text", text: buf.toString("utf8"), lang: "plaintext" };
    }
  }
  return { ...base, kind: "unsupported", message: "No preview available for this file type" };
}
