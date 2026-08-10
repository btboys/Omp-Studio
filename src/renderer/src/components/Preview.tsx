import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useStore } from "../store";
import { parseDiff } from "../lib/diff";
import type { DiffLine } from "../lib/diff";
import type { FileDiffResult } from "../lib/types";
import { Markdown } from "../lib/markdown";
import { formatBytes } from "../lib/format";
import { Close, Contract, Copy, Expand, Refresh } from "./icons";

[
  ["bash", bash],
  ["cpp", cpp],
  ["csharp", csharp],
  ["css", css],
  ["dockerfile", dockerfile],
  ["go", go],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["kotlin", kotlin],
  ["lua", lua],
  ["markdown", markdown],
  ["php", php],
  ["powershell", powershell],
  ["python", python],
  ["ruby", ruby],
  ["rust", rust],
  ["sql", sql],
  ["swift", swift],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
].forEach(([name, grammar]) => hljs.registerLanguage(name as string, grammar as any));

const PREVIEW_WIDTH_KEY = "pi-studio.preview-width";
const PREVIEW_DEFAULT_WIDTH = 420;
const PREVIEW_MIN_WIDTH = 300;
const PREVIEW_MAX_WIDTH = 900;

function clampPreviewWidth(width: number): number {
  const sidebarWidth = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect().width || 0;
  const available = Math.max(PREVIEW_MIN_WIDTH, window.innerWidth - sidebarWidth - 320);
  return Math.min(Math.min(PREVIEW_MAX_WIDTH, available), Math.max(PREVIEW_MIN_WIDTH, width));
}

function initialPreviewWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampPreviewWidth(saved) : clampPreviewWidth(PREVIEW_DEFAULT_WIDTH);
  } catch {
    return PREVIEW_DEFAULT_WIDTH;
  }
}

export function Preview() {
  const open = useStore((s) => s.previewOpen);
  const path = useStore((s) => s.previewPath);
  const root = useStore((s) => s.previewRoot);
  const payload = useStore((s) => s.previewPayload);
  const loading = useStore((s) => s.previewLoading);
  const commitHash = useStore((s) => s.previewCommitHash);
  const expanded = useStore((s) => s.previewExpanded);
  const openPreview = useStore((s) => s.openPreview);
  const toggleExpanded = useStore((s) => s.togglePreviewExpanded);
  const close = useStore((s) => s.closePreview);
  const language = useStore((s) => s.config?.language || "en");
  const [previewWidth, setPreviewWidth] = useState(initialPreviewWidth);
  const [view, setView] = useState<"file" | "diff">("file");
  const [diffNonce, setDiffNonce] = useState(0);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number; element: HTMLDivElement } | null>(null);

  useEffect(() => {
    setView("file");
  }, [path]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      drag.width = clampPreviewWidth(drag.startWidth + drag.startX - event.clientX);
      setPreviewWidth(drag.width);
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      resizeRef.current = null;
      document.body.classList.remove("preview-resizing");
      if (drag.element.hasPointerCapture(event.pointerId)) drag.element.releasePointerCapture(event.pointerId);
      try {
        localStorage.setItem(PREVIEW_WIDTH_KEY, String(Math.round(drag.width)));
      } catch {
        // Resizing still works when persistent storage is unavailable.
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.classList.remove("preview-resizing");
    };
  }, []);

  const persistPreviewWidth = (width: number) => {
    const next = clampPreviewWidth(width);
    setPreviewWidth(next);
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(Math.round(next)));
    } catch {
      // See pointer-up persistence note above.
    }
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || expanded) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      startX: event.clientX,
      startWidth: previewWidth,
      width: previewWidth,
      element: event.currentTarget,
    };
    document.body.classList.add("preview-resizing");
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistPreviewWidth(previewWidth + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistPreviewWidth(previewWidth - 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      persistPreviewWidth(PREVIEW_DEFAULT_WIDTH);
    }
  };

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      toggleExpanded();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, toggleExpanded]);

  if (!open) return null;
  const name = path?.split(/[\\/]/).pop() || "Preview";
  const diffable = !!payload && (payload.kind === "text" || payload.kind === "markdown");
  const refreshPreview = () => {
    if (view === "diff" || commitHash) setDiffNonce((nonce) => nonce + 1);
    if (path) openPreview(path, root || undefined, commitHash || undefined);
  };

  return (
    <aside
      className={`preview ${expanded ? "expanded" : ""}`}
      style={expanded ? undefined : { width: previewWidth, flexBasis: previewWidth }}
    >
      {!expanded && (
        <div
          className="preview-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={language === "zh" ? "调整预览栏宽度" : "Resize preview pane"}
          aria-valuemin={PREVIEW_MIN_WIDTH}
          aria-valuemax={PREVIEW_MAX_WIDTH}
          aria-valuenow={Math.round(previewWidth)}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => persistPreviewWidth(PREVIEW_DEFAULT_WIDTH)}
          title={language === "zh" ? "拖动调整预览栏宽度；双击恢复默认" : "Drag to resize; double-click to reset"}
        />
      )}
      <div className="preview-head">
        <span className="preview-title" title={path || ""}>
          {name}
          {commitHash && <span className="pv-commit-chip">@{commitHash.slice(0, 7)}</span>}
        </span>
        {payload && <span className="muted preview-size">{formatBytes(payload.size)}</span>}
        {payload && <span className="preview-kind">{previewKindLabel(payload)}</span>}
        {!commitHash && diffable && (
          <span className="pv-view-toggle" role="tablist" aria-label={language === "zh" ? "预览视图" : "Preview view"}>
            <button
              role="tab"
              aria-selected={view === "file"}
              className={view === "file" ? "active" : ""}
              onClick={() => setView("file")}
            >
              {language === "zh" ? "文件" : "File"}
            </button>
            <button
              role="tab"
              aria-selected={view === "diff"}
              className={view === "diff" ? "active" : ""}
              onClick={() => setView("diff")}
            >
              Diff
            </button>
          </span>
        )}
        {!expanded ? (
          <button
            className="iconbtn preview-expand-btn"
            title={language === "zh" ? "展开预览" : "Expand preview"}
            aria-label={language === "zh" ? "展开预览" : "Expand preview"}
            aria-pressed={false}
            onClick={toggleExpanded}
          >
            <Expand size={15} />
          </button>
        ) : (
          <button
            className="iconbtn preview-collapse-btn"
            title={language === "zh" ? "收缩到侧边栏" : "Restore side preview"}
            aria-label={language === "zh" ? "收缩到侧边栏" : "Restore side preview"}
            aria-pressed={true}
            onClick={toggleExpanded}
          >
            <Contract size={15} />
            <span>{language === "zh" ? "收缩" : "Restore"}</span>
          </button>
        )}
        <button
          className="iconbtn"
          title={language === "zh" ? "刷新预览" : "Refresh preview"}
          disabled={!path || loading}
          onClick={refreshPreview}
        >
          <Refresh size={14} />
        </button>
        <button className="iconbtn" title={language === "zh" ? "关闭" : "Close"} onClick={close}>
          <Close size={15} />
        </button>
      </div>
      <div className={`preview-body ${payload?.kind === "html" ? "html-preview-active" : ""}`}>
        {loading ? (
          <div className="pv-loading"><span className="spinner" /></div>
        ) : commitHash ? (
          <DiffPreview key={`${path}:${diffNonce}`} path={path || ""} root={root} language={language} commitHash={commitHash} />
        ) : view === "diff" && diffable && path ? (
          <DiffPreview key={`${path}:${diffNonce}`} path={path} root={root} language={language} />
        ) : (
          <PreviewBody payload={payload} language={language} path={path || ""} />
        )}
      </div>
    </aside>
  );
}

function previewKindLabel(payload: any): string {
  if (payload.kind === "html") return "HTML · CSS · JS";
  if (payload.kind === "docx") return "WORD";
  if (payload.kind === "xlsx") return "EXCEL";
  if (payload.kind === "pptx") return "POWERPOINT";
  if (payload.kind === "markdown") return "MARKDOWN";
  if (payload.kind === "image") return "IMAGE";
  return (payload.lang || payload.ext?.slice(1) || "FILE").toUpperCase();
}

function PreviewBody({ payload, language, path }: { payload: any; language: string; path: string }) {
  if (!payload) {
    return (
      <div className="pv-empty">
        {language === "zh" ? "从左侧文件树选择文件进行预览。" : "Select a file from the sidebar to preview it."}
        <br />
        {language === "zh"
          ? "支持代码、Markdown、HTML、图片、Word、Excel 和 PowerPoint。"
          : "Supports code, Markdown, HTML, images, Word, Excel, and PowerPoint."}
      </div>
    );
  }
  switch (payload.kind) {
    case "text":
      return <CodePreview text={payload.text || ""} lang={payload.lang || "plaintext"} truncated={payload.truncated} language={language} path={path} />;
    case "markdown":
      return <div className="pv-md"><Markdown text={payload.text || ""} /></div>;
    case "html":
      return <HtmlPreview url={payload.previewUrl} language={language} />;
    case "image":
      return <div className="pv-img"><img src={`data:${payload.mime};base64,${payload.base64}`} alt={payload.name} /></div>;
    case "docx":
      return <DocxPreview base64={payload.base64} />;
    case "xlsx":
      return <XlsxPreview base64={payload.base64} text={payload.text} />;
    case "pptx":
      return <PptxPreview base64={payload.base64} language={language} />;
    case "toobig":
      return <div className="pv-unsupported">{language === "zh" ? "文件过大，无法预览。" : "This file is too large to preview."}</div>;
    case "missing":
      return <div className="pv-unsupported">{payload.message || (language === "zh" ? "文件不存在。" : "File not found.")}</div>;
    default:
      return <div className="pv-unsupported">{payload.message || (language === "zh" ? "暂不支持预览该格式。" : "Preview is not available for this format.")}</div>;
  }
}

/**
 * Floating "add to conversation" button shown when the user selects a code
 * range inside a file/diff preview. Appends `path:startLine` + the selection
 * as a fenced block to the active thread's composer, with the caret placed
 * after the block so the user can immediately type a follow-up prompt.
 */
function SelectionQuoteButton({
  containerRef,
  path,
  fenceLang,
  linesOf,
}: {
  containerRef: RefObject<HTMLElement | null>;
  path: string;
  fenceLang?: string;
  /** Map the selection's start/end nodes to the quoted range: 1-based start
   *  line and the full-line text (excluding line-number gutter). */
  linesOf: (startNode: Node, endNode: Node) => { line: number; text: string } | null;
}) {
  const language = useStore((s) => s.config?.language || "en");
  const [quote, setQuote] = useState<{ left: number; top: number; line: number; text: string } | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setQuote(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const info = linesOf(range.startContainer, range.endContainer);
      if (!info) {
        setQuote(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setQuote(null);
        return;
      }
      setQuote({ left: Math.min(rect.left, window.innerWidth - 130), top: rect.bottom + 6, line: info.line, text: info.text });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [containerRef, linesOf]);

  useEffect(() => {
    if (!quote) return;
    const close = (event?: Event) => {
      const target = event?.target;
      if (target instanceof Node && buttonRef.current?.contains(target)) return;
      setQuote(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("mousedown", close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuote(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [quote]);

  const add = () => {
    if (!quote) return;
    const store = useStore.getState();
    const threadId = store.activeThreadId;
    if (!threadId) {
      store.pushToast("warning", language === "zh" ? "请先打开一个会话" : "Open a conversation first");
      setQuote(null);
      return;
    }
    const snippet = `\`${path}:${quote.line}\`\n\`\`\`${fenceLang || ""}\n${quote.text}\n\`\`\`\n`;
    const previous = store.drafts[threadId] ?? "";
    store.setComposerDraft(threadId, previous ? `${previous}\n${snippet}` : snippet);
    store.pushToast("success", language === "zh" ? "已添加到对话" : "Added to conversation");
    // Focus the composer with the caret after the inserted block.
    const ta = document.querySelector<HTMLTextAreaElement>(".composer-input textarea");
    ta?.focus();
    requestAnimationFrame(() => {
      const end = ta?.value.length ?? 0;
      ta?.setSelectionRange(end, end);
    });
    setQuote(null);
  };

  if (!quote) return null;
  return (
    <div
      ref={buttonRef}
      className="pv-quote-btn"
      style={{ left: quote.left, top: quote.top }}
      role="button"
      title={`${path}:${quote.line}`}
      onClick={add}
    >
      {language === "zh" ? "添加到对话" : "Add to chat"}
    </div>
  );
}

function CodePreview({
  text,
  lang,
  truncated,
  language,
  path,
}: {
  text: string;
  lang: string;
  truncated?: boolean;
  language: string;
  path: string;
}) {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLPreElement>(null);
  const highlighted = useMemo(() => {
    try {
      return hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
    } catch {
      return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] || char);
    }
  }, [lang, text]);
  const lines = highlighted.split("\n");
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="pv-code">
      <div className="pv-code-toolbar">
        <span className="pv-code-language">{lang}</span>
        <span className="pv-code-lines">{lines.length} {language === "zh" ? "行" : "lines"}</span>
        <button onClick={copy}>
          <Copy size={12} />
          {copied ? (language === "zh" ? "已复制" : "Copied") : language === "zh" ? "复制" : "Copy"}
        </button>
      </div>
      <pre className="pv-code-content" ref={containerRef}>
        <code>
          {lines.map((line, index) => (
            <span className="pv-code-line" key={index}>
              <span className="pv-code-number" aria-hidden="true">{index + 1}</span>
              <span className="pv-code-source" dangerouslySetInnerHTML={{ __html: line || " " }} />
            </span>
          ))}
        </code>
      </pre>
      <SelectionQuoteButton
        containerRef={containerRef}
        path={path}
        fenceLang={lang}
        linesOf={(startNode, endNode) => {
          const lines = Array.from(containerRef.current?.querySelectorAll(".pv-code-line") || []);
          const indexOf = (node: Node) => {
            const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
            const lineEl = el?.closest(".pv-code-line");
            return lineEl ? lines.indexOf(lineEl) : -1;
          };
          const start = indexOf(startNode);
          const end = indexOf(endNode);
          if (start < 0 || end < 0) return null;
          const text = lines
            .slice(start, end + 1)
            .map((lineEl) => lineEl.querySelector(".pv-code-source")?.textContent ?? "")
            .join("\n");
          return { line: start + 1, text };
        }}
      />
      {truncated && <div className="pv-code-truncated">{language === "zh" ? "文件过大，已截断。" : "Large file; preview truncated."}</div>}
    </div>
  );
}

function HtmlPreview({ url, language }: { url?: string; language: string }) {
  if (!url) return <div className="pv-unsupported">{language === "zh" ? "无法创建 HTML 预览地址。" : "Could not create the HTML preview URL."}</div>;
  return (
    <div className="pv-html">
      <iframe
        key={url}
        title="html-preview"
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock"
      />
    </div>
  );
}

function DocxPreview({ base64 }: { base64: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mammoth = await import("mammoth");
        const buf = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const res = await mammoth.default.convertToHtml({ arrayBuffer: buf.buffer as ArrayBuffer });
        if (!cancelled) setHtml(res.value);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "docx parse failed");
      }
    })();
    return () => { cancelled = true; };
  }, [base64]);
  if (err) return <div className="pv-unsupported">{err}</div>;
  if (html == null) return <div className="pv-loading"><span className="spinner" /></div>;
  return <div className="pv-docx" dangerouslySetInnerHTML={{ __html: html }} />;
}

function XlsxPreview({ base64, text }: { base64?: string; text?: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = text
          ? XLSX.read(text, { type: "string" })
          : XLSX.read(Uint8Array.from(atob(base64 || ""), (c) => c.charCodeAt(0)), { type: "array" });
        const out = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false }),
        }));
        if (!cancelled) setSheets(out);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "xlsx parse failed");
      }
    })();
    return () => { cancelled = true; };
  }, [base64, text]);
  if (err) return <div className="pv-unsupported">{err}</div>;
  if (!sheets.length) return <div className="pv-loading"><span className="spinner" /></div>;
  return (
    <div className="pv-xlsx">
      <div className="sheet-tabs">
        {sheets.map((sheet, index) => (
          <button key={sheet.name} className={`sheet-tab ${index === active ? "active" : ""}`} onClick={() => setActive(index)}>
            {sheet.name}
          </button>
        ))}
      </div>
      <div className="pv-xlsx-sheet" dangerouslySetInnerHTML={{ __html: sheets[active]?.html || "" }} />
    </div>
  );
}

type PptxSlide = {
  number: number;
  title: string;
  paragraphs: string[];
  images: { src: string; alt: string }[];
};

function normalizeZipPath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function imageMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "gif" ? "image/gif"
      : ext === "svg" ? "image/svg+xml"
        : ext === "webp" ? "image/webp"
          : "image/png";
}

function PptxPreview({ base64, language }: { base64: string; language: string }) {
  const [slides, setSlides] = useState<PptxSlide[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const JSZip = (await import("jszip")).default;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const zip = await JSZip.loadAsync(bytes);
        const slidePaths = Object.keys(zip.files)
          .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
          .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
        const parsed: PptxSlide[] = [];

        for (let index = 0; index < slidePaths.length; index++) {
          const slidePath = slidePaths[index];
          const xml = await zip.file(slidePath)!.async("text");
          const doc = new DOMParser().parseFromString(xml, "application/xml");
          const paragraphs = Array.from(doc.getElementsByTagName("a:p"))
            .map((paragraph) =>
              Array.from(paragraph.getElementsByTagName("a:t"))
                .map((node) => node.textContent || "")
                .join("")
                .trim()
            )
            .filter(Boolean);

          const relPath = slidePath.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
          const relFile = zip.file(relPath);
          const relationTargets = new Map<string, string>();
          if (relFile) {
            const relXml = await relFile.async("text");
            const relDoc = new DOMParser().parseFromString(relXml, "application/xml");
            for (const relation of Array.from(relDoc.getElementsByTagName("Relationship"))) {
              const id = relation.getAttribute("Id");
              const target = relation.getAttribute("Target");
              if (id && target) relationTargets.set(id, normalizeZipPath(`ppt/slides/${target}`));
            }
          }

          const images: PptxSlide["images"] = [];
          for (const blip of Array.from(doc.getElementsByTagName("a:blip"))) {
            const relationshipId = blip.getAttribute("r:embed");
            const target = relationshipId ? relationTargets.get(relationshipId) : null;
            const file = target ? zip.file(target) : null;
            if (!target || !file) continue;
            const encoded = await file.async("base64");
            images.push({ src: `data:${imageMime(target)};base64,${encoded}`, alt: target.split("/").pop() || "slide image" });
          }

          parsed.push({
            number: index + 1,
            title: paragraphs[0] || `${language === "zh" ? "幻灯片" : "Slide"} ${index + 1}`,
            paragraphs: paragraphs.slice(1),
            images,
          });
        }
        if (!cancelled) setSlides(parsed);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "pptx parse failed");
      }
    })();
    return () => { cancelled = true; };
  }, [base64, language]);

  if (err) return <div className="pv-unsupported">{err}</div>;
  if (!slides.length) return <div className="pv-loading"><span className="spinner" /></div>;
  return (
    <div className="pv-pptx">
      <div className="pv-pptx-summary">{slides.length} {language === "zh" ? "张幻灯片" : slides.length === 1 ? "slide" : "slides"}</div>
      {slides.map((slide) => (
        <article className="pv-slide" key={slide.number}>
          <div className="pv-slide-number">{String(slide.number).padStart(2, "0")}</div>
          <div className="pv-slide-canvas">
            <h2>{slide.title}</h2>
            {slide.paragraphs.length > 0 && (
              <div className="pv-slide-copy">
                {slide.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              </div>
            )}
            {slide.images.length > 0 && (
              <div className="pv-slide-images">
                {slide.images.map((image, index) => <img src={image.src} alt={image.alt} key={`${image.alt}-${index}`} />)}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

/**
 * Diff view for the currently previewed file. Normal mode: `git diff HEAD`
 * for the path (what the agent changed since the last commit). Commit mode
 * (`commitHash` set): the file's diff inside that commit (`git show`).
 * Fetched lazily from the main process; the file preview itself is untouched.
 */
function DiffPreview({ path, root, language, commitHash }: { path: string; root: string | null; language: string; commitHash?: string | null }) {
  const [result, setResult] = useState<FileDiffResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (commitHash && root) {
      // previewPath is absolute under the repo root; git wants the rel path.
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
      window.pi.git
        .commitFileDiff(root, commitHash, rel)
        .then((diff) => {
          if (!cancelled) setResult({ ok: true, diff, newFile: /^new file mode/m.test(diff) });
        })
        .catch((e: any) => {
          if (!cancelled) setErr(e?.message || "commitFileDiff failed");
        });
      return () => {
        cancelled = true;
      };
    }
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    window.pi.app
      .getFileDiff(root || dir, path)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((e: any) => {
        if (!cancelled) setErr(e?.message || "getFileDiff failed");
      });
    return () => {
      cancelled = true;
    };
  }, [path, root, commitHash]);

  if (err) return <div className="pv-unsupported">{err}</div>;
  if (!result) return <div className="pv-loading"><span className="spinner" /></div>;
  if (!result.ok) {
    return <div className="pv-unsupported">{(language === "zh" ? "无法获取 diff：" : "Could not load diff: ") + result.error}</div>;
  }
  if (!result.diff) {
    return commitHash ? (
      <div className="pv-unsupported">{language === "zh" ? "无变更内容。" : "No diff."}</div>
    ) : (
      <div className="pv-unsupported">
        {result.newFile
          ? language === "zh"
            ? "新增文件（二进制，无法显示内容 diff）。"
            : "New file (binary; content diff unavailable)."
          : language === "zh"
            ? "无未提交变更（与最近提交一致）。"
            : "No uncommitted changes (matches the last commit)."}
      </div>
    );
  }
  return <DiffView diff={result.diff} newFile={result.newFile} language={language} path={path} />;
}

function DiffView({ diff, newFile, language, path }: { diff: string; newFile: boolean; language: string; path: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const containerRef = useRef<HTMLDivElement>(null);
  const t = (zh: string, en: string) => (language === "zh" ? zh : en);
  return (
    <div className="pv-diff">
      <div className="pv-diff-stats">
        <span>{parsed.files} {parsed.files === 1 ? t("个文件", "file") : t("个文件", "files")}</span>
        <span className="pv-diff-add">+{parsed.additions}</span>
        <span className="pv-diff-del">−{parsed.deletions}</span>
        {newFile && <span className="pv-diff-newfile">{t("新文件", "new file")}</span>}
      </div>
      <div className="pv-diff-lines" ref={containerRef}>
        {parsed.lines.map((line, index) => (
          <DiffRow key={index} line={line} />
        ))}
      </div>
      <SelectionQuoteButton
        containerRef={containerRef}
        path={path}
        fenceLang="diff"
        linesOf={(startNode, endNode) => {
          const rows = Array.from(containerRef.current?.querySelectorAll(".pv-diff-line") || []);
          const indexOf = (node: Node) => {
            const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
            const row = el?.closest(".pv-diff-line");
            return row ? rows.indexOf(row) : -1;
          };
          const start = indexOf(startNode);
          const end = indexOf(endNode);
          if (start < 0 || end < 0) return null;
          const first = parsed.lines[start];
          if (!first) return null;
          let line = 0;
          for (let i = start; i <= end && !line; i++) {
            const l = parsed.lines[i];
            line = l?.newNo ?? l?.oldNo ?? 0;
          }
          if (!line) return null;
          const text = rows
            .slice(start, end + 1)
            .map((row) => row.querySelector(".pv-diff-text")?.textContent ?? row.querySelector(".pv-diff-full")?.textContent ?? "")
            .join("\n");
          return { line, text };
        }}
      />
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "file" || line.kind === "hunk" || line.kind === "meta") {
    return (
      <div className={`pv-diff-line ${line.kind}`}>
        <span className="pv-diff-full">{line.text || " "}</span>
      </div>
    );
  }
  return (
    <div className={`pv-diff-line ${line.kind}`}>
      <span className="pv-diff-num">{line.oldNo ?? ""}</span>
      <span className="pv-diff-num">{line.newNo ?? ""}</span>
      <span className="pv-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
      <span className="pv-diff-text">{line.text || " "}</span>
    </div>
  );
}
