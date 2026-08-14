import type { ModelInfo } from "./types";

export function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatClock(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function modelLabel(m: ModelInfo | null | undefined): string {
  if (!m) return "No model";
  return m.name || m.id || m.provider;
}

export function modelShort(m: ModelInfo | null | undefined): string {
  if (!m) return "model";
  const n = m.name || m.id || "";
  return n.length > 22 ? n.slice(0, 21) + "…" : n;
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Compact token count, e.g. 1234567 -> "1.23M", 68353 -> "68.4k". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

/**
 * Rough local token estimate for display only (no tokenizer in the bundle):
 * CJK chars ≈ 1 token each, everything else ≈ 4 chars/token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

const FILE_ICON: Record<string, string> = {
  ".pptx": "📙", ".ppt": "📙",
  ".ts": "🟦", ".tsx": "⚛️", ".js": "🟨", ".jsx": "⚛️", ".json": "🧾",
  ".md": "📝", ".markdown": "📝", ".html": "🌐", ".htm": "🌐", ".css": "🎨",
  ".scss": "🎨", ".py": "🐍", ".go": "🐹", ".rs": "🦀", ".java": "☕",
  ".pdf": "📕", ".docx": "📘", ".doc": "📘", ".xlsx": "📗", ".xls": "📗", ".csv": "📊",
  ".png": "🖼️", ".jpg": "🖼️", ".jpeg": "🖼️", ".gif": "🖼️", ".webp": "🖼️", ".svg": "🖼️",
  ".yaml": "⚙️", ".yml": "⚙️", ".toml": "⚙️", ".sh": "🐚", ".bash": "🐚",
};

export function fileIcon(ext: string, isDir: boolean): string {
  if (isDir) return "📁";
  return FILE_ICON[ext.toLowerCase()] || "📄";
}

export function basename(p: string): string {
  const s = p.replace(/\\/g, "/");
  return s.split("/").filter(Boolean).pop() || p;
}
