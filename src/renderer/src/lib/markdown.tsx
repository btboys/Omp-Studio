import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as any)) return extractText((node as any).props?.children);
  return "";
}

function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = (className || "").match(/language-([\w-]+)/)?.[1] || "";
  const text = extractText(children);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang || "code"}</span>
        <button className="code-copy" onClick={copy} title="Copy">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

// Module-level constants: markdown parsing + highlight.js is the single most
// expensive thing the renderer does. ReactMarkdown re-initializes its plugin
// pipeline when the plugin array identity changes, and re-parses the text on
// every render — so everything here must be stable, and the component itself
// is memoized on `text`. Unchanged messages then cost nothing to re-render.
// rehypeRaw is only engaged while a chat search is active (raw HTML is
// otherwise rendered escaped, exactly as before); its array identity is stable
// per mode so toggling search re-initializes the pipeline at most once.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLAIN = [rehypeHighlight];
const REHYPE_SEARCH = [rehypeHighlight, rehypeRaw];
const MD_COMPONENTS = {
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children, ...rest }: any) => {
    const isBlock = /hljs|language-/.test(className || "") || extractText(children).includes("\n");
    if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
    return (
      <code className="inline-code" {...rest}>
        {children}
      </code>
    );
  },
  a: ({ href, children, ...rest }: any) => (
    <a
      href={href}
      {...rest}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (href && /^https?:/i.test(href)) {
          e.preventDefault();
          window.open(href, "_blank");
        }
      }}
    >
      {children}
    </a>
  ),
  table: ({ children }: any) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }: any) => <img className="md-img" src={src} alt={alt || ""} />,
};

/** Backtick inline code spans (`a` / ``a``), matching delimiter runs. */
const INLINE_CODE = /(`+)([^\n]*?)\1/g;
/** Fenced code blocks (``` / ~~~), including both fence lines. */
const FENCED_CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
/** Indented code blocks: consecutive lines with 4+ leading spaces/tabs. */
const INDENTED_CODE = /(^|\n)[ \t]{4,}[^\n]*(?:\n[ \t]{4,}[^\n]*)*/g;

/** Intervals of markdown source that render as code, sorted and merged. Code
 *  content is emitted escaped (never parsed as HTML), so wrapping a match
 *  inside it would show the literal `<mark>` string instead of a highlight.
 *  A lightweight tokenizer pass — biased toward over-matching: a false
 *  positive only skips one highlight, a false negative leaks literal markup. */
function codeRegions(text: string): [number, number][] {
  const regions: [number, number][] = [];
  const collect = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) regions.push([m.index, m.index + m[0].length]);
  };
  collect(FENCED_CODE);
  collect(INLINE_CODE);
  collect(INDENTED_CODE);
  regions.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

function wrapMatches(segment: string, re: RegExp): string {
  return segment.replace(re, (_match, group: string) =>
    `<mark>${group.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</mark>`,
  );
}

/** Wrap case-insensitive matches of `query` in `<mark>` so they render as
 *  highlighted spans (rehypeRaw is engaged only while a search is active).
 *  Matches inside code regions are skipped — the source stays untouched there
 *  and the surrounding markdown keeps parsing normally. The matched spans are
 *  HTML-escaped so arbitrary query text can't break out of the mark element. */
function highlightMarkdownText(text: string, query: string): string {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const regions = codeRegions(text);
  if (!regions.length) return wrapMatches(text, re);
  let out = "";
  let cursor = 0;
  for (const [start, end] of regions) {
    out += wrapMatches(text.slice(cursor, start), re);
    out += text.slice(start, end);
    cursor = end;
  }
  return out + wrapMatches(text.slice(cursor), re);
}

export const Markdown = memo(function Markdown({ text, highlight }: { text: string; highlight?: string }) {
  const active = !!highlight && !!highlight.trim();
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={active ? REHYPE_SEARCH : REHYPE_PLAIN}
        components={MD_COMPONENTS}
      >
        {active ? highlightMarkdownText(text || "", highlight) : text || ""}
      </ReactMarkdown>
    </div>
  );
});
