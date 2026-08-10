import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import type { ProjectSummary } from "../lib/types";
import { Search, Close } from "./icons";

const PAGE_SIZE = 20;

/** Split text around case-insensitive matches of `query` and wrap them in <mark>. */
function highlight(text: string, query: string): ReactNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [text];
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="tl-mark">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

/** Paginated, searchable list of every session in one project. Opened from the
 *  "更多" button below the 10 most recent threads in the sidebar. */
export function ThreadListModal({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const goToThread = useStore((s) => s.goToThread);
  const language = useStore((s) => s.config?.language || "en");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset to the first page whenever the query or the project changes.
  useEffect(() => {
    setPage(0);
  }, [query, project.cwd]);

  // Esc closes even when focus is elsewhere in the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return project.threads;
    return project.threads.filter(
      (t) => t.title.toLowerCase().includes(q) || (t.preview || "").toLowerCase().includes(q)
    );
  }, [project.threads, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const go = (file: string) => {
    onClose();
    void goToThread(project.cwd, file);
  };

  return (
    <div className="search-backdrop" onMouseDown={onClose}>
      <div className="search-modal tl-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="search-input-row">
          <span className="search-ico">
            <Search size={17} />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            placeholder={language === "zh" ? "检索会话标题…" : "Search sessions…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery("")} title={language === "zh" ? "清空" : "Clear"}>
              <Close size={15} />
            </button>
          )}
          <span className="tl-count">
            {filtered.length} {language === "zh" ? "个会话" : "sessions"}
          </span>
        </div>
        <div className="tl-list">
          {rows.length === 0 && <div className="search-empty">{language === "zh" ? "无匹配会话" : "No matching sessions"}</div>}
          {rows.map((t) => (
            <button key={t.file} className="tl-row" onClick={() => go(t.file)} title={t.title}>
              <div className="tl-title">{highlight(t.title, q)}</div>
              {t.preview && t.preview !== t.title && <div className="tl-preview">{t.preview}</div>}
              <div className="tl-meta">
                {t.messageCount} 条 ·{" "}
                {new Date(t.updatedAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            </button>
          ))}
        </div>
        {pageCount > 1 && (
          <div className="tl-pager">
            <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              ‹ {language === "zh" ? "上一页" : "Prev"}
            </button>
            <span>
              {safePage + 1} / {pageCount}
            </span>
            <button disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
              {language === "zh" ? "下一页" : "Next"} ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
