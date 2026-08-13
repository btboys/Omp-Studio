import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDisplayThreadTitle, parseSkillBlock, useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { formatClock, formatTokens } from "../lib/format";
import { collectFileArtifacts, type FileArtifact } from "../lib/artifacts";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { ContentBlock, ToolRun, ViewMessage } from "../lib/types";
import { groupTodosByPhase, replayTodoOps, todosFromPhases, type TodoItem, type TodoOp } from "../lib/todos";
import { subagentRowState, taskBatchOf, type SubagentRowState } from "../lib/subagents";
import { Composer } from "./Composer";
import { ExtUiPromptCard } from "./ExtUiPromptCard";
import { Sidebar, PanelRight, Copy, Refresh, Edit, Folder, Files, Gauge, Branch, Check, ChevronRight, ChevronUp, ChevronDown, Close, Undo, Search, Share } from "./icons";
import appIconUrl from "../../../../resources/icon.png";
/** Default user avatar SVG — consistent person silhouette, no emoji. */
const DEFAULT_USER_AVATAR = (
  <svg viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg" className="msg-user-avatar-svg">
    <circle cx="13" cy="10" r="4.5" fill="currentColor"/>
    <path d="M5.5 22c0-4.14 3.36-7.5 7.5-7.5s7.5 3.36 7.5 7.5" fill="currentColor"/>
  </svg>
);


export type { TodoItem } from "../lib/todos";

/** The current todo list: its items plus the key of the message that owns it. */
interface TodoInfo {
  sourceKey: string;
  items: TodoItem[];
}

/** GFM task-list line: `- [ ] foo`, `* [x] bar`, `1. [X] baz`. */
const TODO_LINE = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.*)$/;

/** Extract markdown checkbox items from assistant text; null when none present. */
function extractTodos(text: string): TodoItem[] | null {
  const items: TodoItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(TODO_LINE);
    if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2].trim(), status: m[1].toLowerCase() === "x" ? "done" : "pending" });
  }
  return items.length ? items : null;
}

/** Render-time only: drop the todo lines from a message so the panel owns them. */
function stripTodoLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !TODO_LINE.test(line))
    .join("\n");
}

/** One subagent row in the panel: a task in a `task` tool call's batch. */
interface SubagentRow {
  name: string;
  agent?: string;
  run: ToolRun;
}

/** The current subagent batch: its rows plus the key of the message that owns it. */
interface SubagentInfo {
  sourceKey: string;
  rows: SubagentRow[];
}

/** Tool names that spawn subagents (omp gates them separately in sandbox mode). */
const SUBAGENT_TOOL = "task";

type ToolCallBlock = Extract<ContentBlock, { type: "toolCall" }>;

/** Parse the subagent rows of a `task` tool call. Names come from the batch
 *  `tasks[]` (block args → execution args), else the batch intent. */
function subagentRowsOf(block: ToolCallBlock, run: ToolRun): SubagentRow[] {
  const batch = taskBatchOf(block.arguments, run);
  if (batch.tasks.length) return batch.tasks.map((t) => ({ name: t.name || "", agent: t.agent, run }));
  return [{ name: batch.i, run }];
}

export function Chat({ threadId, secondary = false }: { threadId: string; secondary?: boolean }) {
  const thread = useStore((s) => s.threads[threadId]);
  const focused = useStore((s) => s.activeThreadId === threadId);
  const setActiveThread = useStore((s) => s.setActiveThread);
  const unsplitThread = useStore((s) => s.unsplitThread);
  const chatScrollSeq = useStore((s) => s.chatScrollSeq);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePreview = useStore((s) => s.togglePreview);
  const reloadThread = useStore((s) => s.reloadThread);
  const shareThread = useStore((s) => s.shareThread);
  const renameThread = useStore((s) => s.renameThread);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // context-usage popover
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxStats, setCtxStats] = useState<any>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  useOutsideClose(ctxRef, ctxOpen, () => setCtxOpen(false));

  // in-conversation search + quick jump between user prompts
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const [userIdx, setUserIdx] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  useOutsideClose(searchRef, searchOpen, () => {
    setSearchOpen(false);
    setSearchQuery("");
  });

  const streaming = thread?.streaming;
  const count = (thread?.messages.length || 0) + (streaming ? 1 : 0);

  // auto-scroll to bottom on new content (only while already near bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (near) el.scrollTop = el.scrollHeight;
  }, [count, streaming?.blocks?.length, thread?.messages.length]);

  // Force pin to bottom when opening/switching a historical session or reloading.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !threadId || thread?.loading) return;
    const go = () => {
      el.scrollTop = el.scrollHeight;
    };
    go();
    const raf = requestAnimationFrame(go);
    const t1 = window.setTimeout(go, 50);
    const t2 = window.setTimeout(go, 200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [threadId, chatScrollSeq, thread?.loading]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setPreviewImage(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  // Must stay above any early return: thread.loading used to skip this hook and
  // white-screen the app (React hook-order violation).
  const groups = useMemo(() => groupMessages(thread?.messages || []), [thread?.messages]);

  // The 撤回 action anchors on the newest user message — the one undo removes.
  // Keep this above early returns so hook order stays stable when thread is
  // briefly missing during tab remap / history open.
  const lastUserKey = useMemo(() => {
    const messages = thread?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].key;
    }
    return null;
  }, [thread?.messages]);

  // msgKey -> groupKey: assistant rounds share one DOM container per group, so
  // scrolling targets the group element that owns a matched message.
  const groupKeyByMsg = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) for (const m of g.items) map.set(m.key, g.key);
    return map;
  }, [groups]);

  // Every match of the query across user/system text and assistant text blocks
  // (thinking + tool payloads are out of scope). One entry per occurrence so
  // prev/next walks each hit, and the counter reflects total occurrences.
  const searchHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as { groupKey: string; msgKey: string }[];
    const hits: { groupKey: string; msgKey: string }[] = [];
    for (const m of thread?.messages || []) {
      const text =
        m.role === "assistant"
          ? (m.blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n")
          : m.text || "";
      let i = text.toLowerCase().indexOf(q);
      while (i !== -1) {
        hits.push({ groupKey: groupKeyByMsg.get(m.key) || m.key, msgKey: m.key });
        i = text.toLowerCase().indexOf(q, i + q.length);
      }
    }
    return hits;
  }, [searchQuery, thread?.messages, groupKeyByMsg]);

  // User-prompt groups, for the quick jump controls: the popover's prev/next
  // buttons and the left anchor rail. Text is a trimmed preview for tooltips.
  const userRails = useMemo(
    () =>
      groups
        .filter((g) => g.role === "user")
        .map((g) => {
          const full = (g.items[0]?.text || "").trim();
          const text = full.replace(/\s+/g, " ").slice(0, 40);
          return { key: g.key, text, fullText: full };
        }),
    [groups],
  );

  // Left anchor rail: keep the dot of the user prompt nearest the viewport
  // highlighted while scrolling, and while the transcript grows during
  // streaming (a message's position changes as content above it lands).
  const [railActive, setRailActive] = useState<string | null>(null);
  // Hover preview: which rail dot is hovered + the fixed position the preview
  // card should anchor to (the dot's viewport rect, captured on mouseenter).
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ left: number; top: number } | null>(null);
  const hoveredRail = hoverKey ? userRails.find((r) => r.key === hoverKey) ?? null : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !userRails.length) {
      setRailActive(null);
      return;
    }
    const updateActive = () => {
      const mid = el.clientHeight * 0.4;
      const elTop = el.getBoundingClientRect().top;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const r of userRails) {
        const node = el.querySelector(`[data-msg-key="${CSS.escape(r.key)}"]`) as HTMLElement | null;
        if (!node) continue;
        const d = Math.abs(node.getBoundingClientRect().top - elTop - mid);
        if (d < bestDist) {
          bestDist = d;
          best = r.key;
        }
      }
      setRailActive(best);
    };
    updateActive();
    // Scrolling moves the dots under a hovered preview, so dismiss it (the
    // active-dot marker still tracks via the interval below).
    const onScroll = () => {
      updateActive();
      setHoverKey(null);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const timer = window.setInterval(updateActive, 400);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearInterval(timer);
    };
  }, [userRails, thread?.messages.length, count]);

  // Current todos = the newest assistant message (committed or streaming) that
  // carries one. Sources, in priority order:
  // 1. todo toolResult `details.phases` (richest: includes phase names like "Tasks")
  // 2. GFM checkbox lines in the message text (Claude Code-style)
  // 3. replay of `todo` tool-call args (stateful ops / full-state todos)
  // The owning message's todo lines are stripped from the stream and shown in
  // the collapsible panel.
  const todoInfo = useMemo<TodoInfo | null>(() => {
    const msgs = thread ? [...thread.messages, ...(streaming ? [streaming] : [])] : [];
    const toolRuns = thread?.toolRuns || {};

    // Prefer the latest todo tool result details.phases — tool-call args often
    // omit `phase`, while the result always carries the phase tree the panel
    // should show (e.g. "Tasks · 0/3").
    let fromDetails: TodoInfo | null = null;
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      for (const b of m.blocks || []) {
        if (b.type !== "toolCall" || b.name !== "todo") continue;
        const phases = toolRuns[b.id]?.details?.phases;
        const items = todosFromPhases(phases);
        if (items.length) fromDetails = { sourceKey: m.key, items };
      }
    }
    if (fromDetails) return fromDetails;

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const text = (m.blocks || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const items = extractTodos(text);
      if (items) return { sourceKey: m.key, items };
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      if (!(m.blocks || []).some((b) => b.type === "toolCall" && b.name === "todo")) continue;
      const ops: TodoOp[] = [];
      for (const sm of msgs) {
        if (sm.role !== "assistant") continue;
        for (const b of sm.blocks || []) {
          if (b.type === "toolCall" && b.name === "todo") ops.push(b.arguments as TodoOp);
        }
      }
      const items = replayTodoOps(ops);
      if (items.length) return { sourceKey: m.key, items };
    }
    return null;
  }, [thread?.messages, streaming, thread?.toolRuns]);

  // Current subagent batch = the newest assistant message (committed or
  // streaming) whose `task` tool calls have live runs. Shown in a collapsible
  // panel above the composer, mirroring the todo panel.
  const subagentInfo = useMemo<SubagentInfo | null>(() => {
    const msgs = thread ? [...thread.messages, ...(streaming ? [streaming] : [])] : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const rows: SubagentRow[] = [];
      for (const b of m.blocks || []) {
        if (b.type !== "toolCall") continue;
        if (b.name !== SUBAGENT_TOOL) continue;
        const run = thread?.toolRuns[b.id];
        if (!run) continue;
        rows.push(...subagentRowsOf(b, run));
      }
      if (rows.length) return { sourceKey: m.key, rows };
    }
    return null;
  }, [thread?.messages, streaming, thread?.toolRuns]);

  if (!thread) return null;

  const paneClass = `chat-pane${secondary ? " chat-pane-secondary" : ""}${focused ? " focused" : ""}`;
  const focusPane = () => {
    if (!focused) setActiveThread(threadId);
  };

  // Optimistic open: the omp process is still booting. Show the chrome plus a
  // spinner immediately instead of leaving the previous view frozen.
  if (thread.loading) {
    return (
      <div className={paneClass} onMouseDown={focusPane}>
        <div className="chat-head">
          <button className="iconbtn" title="Toggle sidebar" onClick={toggleSidebar}>
            <Sidebar size={16} />
          </button>
          <div className="chat-head-titlewrap">
            <div key={threadId} className="chat-head-title">{thread.sessionName || "新会话"}</div>
          </div>
          <div className="spacer" />
        </div>
        <div className="chat-loading">
          <span className="spinner" />
          正在启动 omp 进程…
        </div>
      </div>
    );
  }

  const firstUserText = thread.messages.find((m) => m.role === "user")?.text || "";
  const title = getDisplayThreadTitle(thread.sessionName, firstUserText).slice(0, 40) || "新会话";

  // Undo needs a persisted session with at least one user prompt, and must wait
  // for any in-flight reply to settle before the file can be truncated.
  const canUndo = !thread.isStreaming && !!thread.sessionFile && thread.messages.some((m) => m.role === "user");

  // Sharing needs a persisted, settled session so the uploaded snapshot is complete.
  const canShare = !thread.isStreaming && !!thread.sessionFile;

  const lastGroup = groups[groups.length - 1];
  const streamingExtends = !!streaming && !!lastGroup && lastGroup.role === "assistant";
  const headGroups = streamingExtends ? groups.slice(0, -1) : groups;

  const startRename = () => {
    setEditValue(thread.sessionName || "");
    setEditing(true);
    requestAnimationFrame(() => editInputRef.current?.focus());
  };

  const commitRename = () => {
    setEditing(false);
    const v = editValue.trim();
    if (v) renameThread(threadId, v);
  };

  const cancelRename = () => {
    setEditing(false);
  };

  const loadCtx = async () => {
    if (!threadId) return;
    setCtxLoading(true);
    try {
      const id = await useStore.getState().ensureConnected(threadId);
      setCtxStats(id ? await window.pi.thread.getStats(id) : null);
    } catch {
      setCtxStats(null);
    }
    setCtxLoading(false);
  };
  const toggleCtx = () => {
    const next = !ctxOpen;
    setCtxOpen(next);
    if (next) loadCtx();
  };

  const ctxUsage = ctxStats?.contextUsage;
  const ctxUsed = ctxUsage?.tokens ?? 0;
  const ctxTotal = ctxUsage?.contextWindow ?? 0;
  const ctxRemaining = Math.max(0, ctxTotal - ctxUsed);
  const ctxPct = ctxUsage ? ctxUsage.percent ?? (ctxTotal ? Math.round((ctxUsed / ctxTotal) * 100) : 0) : 0;

  // Scroll a message group into view and flash it so the current hit is
  // obvious among many matches.
  const scrollToKey = (key: string) => {
    setHoverKey(null);
    const el = scrollRef.current?.querySelector(`[data-msg-key="${CSS.escape(key)}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("msg-flash");
    void el.offsetWidth; // restart the animation on repeat jumps
    el.classList.add("msg-flash");
    window.setTimeout(() => el.classList.remove("msg-flash"), 1600);
  };

  const goHit = (delta: number) => {
    const n = searchHits.length;
    if (!n) return;
    const next = ((searchIdx + delta) % n + n) % n;
    setSearchIdx(next);
    scrollToKey(searchHits[next].groupKey);
  };

  const goUser = (delta: number) => {
    const n = userRails.length;
    if (!n) return;
    const next = ((userIdx + delta) % n + n) % n;
    setUserIdx(next);
    scrollToKey(userRails[next].key);
  };

  const shownHit = searchHits.length ? Math.min(searchIdx, searchHits.length - 1) : 0;
  const shownUser = userRails.length ? Math.min(userIdx, userRails.length - 1) : 0;

  return (
    <div className={paneClass} onMouseDown={focusPane}>
      <div className="chat-head">
        <button className="iconbtn" title="Toggle sidebar" onClick={toggleSidebar}>
          <Sidebar size={16} />
        </button>
        <div className="chat-head-titlewrap">
          {editing ? (
            <input
              ref={editInputRef}
              className="chat-head-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={commitRename}
            />
          ) : (
            <>
              <div key={threadId} className="chat-head-title" title={title} onDoubleClick={startRename}>
                <span className="chat-head-title-text">{title}</span>
                <button
                  type="button"
                  className="chat-head-rename"
                  title="重命名"
                  aria-label={`重命名：${title}`}
                  onClick={startRename}
                >
                  <Edit size={13} />
                </button>
              </div>
              {thread.cwd && (
                <div className="chat-head-subrow">
                  <button
                    className="chat-head-folder"
                    title={`在文件管理器中打开：${thread.cwd}`}
                    onClick={() => {
                      window.pi.settings.openPath(thread.cwd).catch(() => {});
                    }}
                  >
                    <Folder size={11} />
                    <span className="chat-head-folder-path">{thread.cwd}</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {!thread.connected && (
          <span className="chat-connecting" title="omp 进程连接中；历史已可浏览，发送消息会自动等待连接完成">
            <span className="spinner" /> 连接中
          </span>
        )}
        <div className="spacer" />
        <div className="chat-search-wrap" ref={searchRef}>
          <button className={`iconbtn ${searchOpen ? "on" : ""}`} title="搜索对话内容" onClick={() => setSearchOpen((v) => !v)}>
            <Search size={15} />
          </button>
          {searchOpen && (
            <div className="chat-search-pop">
              <div className="chat-search-input-row">
                <Search size={13} />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      goHit(e.shiftKey ? -1 : 1);
                    }
                    if (e.key === "Escape") {
                      setSearchOpen(false);
                      setSearchQuery("");
                    }
                  }}
                  placeholder="搜索对话内容…"
                />
                {searchQuery.trim() && (
                  <span className="chat-search-count">
                    {searchHits.length ? `${shownHit + 1}/${searchHits.length}` : "无结果"}
                  </span>
                )}
              </div>
              <div className="chat-search-row">
                <button type="button" title="上一个匹配 (Shift+Enter)" disabled={!searchHits.length} onClick={() => goHit(-1)}>
                  <ChevronUp size={13} />
                </button>
                <button type="button" title="下一个匹配 (Enter)" disabled={!searchHits.length} onClick={() => goHit(1)}>
                  <ChevronDown size={13} />
                </button>
                <span className="chat-search-sep" />
                <button type="button" title="上一条用户消息" disabled={!userRails.length} onClick={() => goUser(-1)}>
                  <ChevronUp size={13} />
                </button>
                <button type="button" title="下一条用户消息" disabled={!userRails.length} onClick={() => goUser(1)}>
                  <ChevronDown size={13} />
                </button>
                <span className="chat-search-count">
                  {userRails.length ? `${shownUser + 1}/${userRails.length}` : "0/0"} 用户
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="ctx-wrap" ref={ctxRef}>
          <button className={`iconbtn ${ctxOpen ? "on" : ""}`} title="当前会话上下文用量" onClick={toggleCtx}>
            <Gauge size={15} />
          </button>
          {ctxOpen && (
            <div className="ctx-pop">
              <div className="ctx-pop-head">
                <span>上下文</span>
                <button className="ctx-refresh" title="刷新" onClick={loadCtx}>
                  <Refresh size={12} />
                </button>
              </div>
              {ctxLoading ? (
                <div className="ctx-loading">
                  <span className="spinner" />
                </div>
              ) : ctxUsage ? (
                <>
                  <div className="ctx-bignum">
                    {formatTokens(ctxUsed)}
                    <span className="ctx-of"> / {formatTokens(ctxTotal)}</span>
                  </div>
                  <div className={`ctx-bar ${ctxPct >= 85 ? "hi" : ctxPct >= 60 ? "mid" : ""}`}>
                    <div className="ctx-bar-fill" style={{ width: `${Math.min(100, ctxPct)}%` }} />
                  </div>
                  <div className="ctx-rows">
                    <div className="ctx-row">
                      <span>已使用</span>
                      <b>{formatTokens(ctxUsed)}</b>
                    </div>
                    <div className="ctx-row">
                      <span>总上下文</span>
                      <b>{formatTokens(ctxTotal)}</b>
                    </div>
                    <div className="ctx-row">
                      <span>剩余</span>
                      <b>{formatTokens(ctxRemaining)}</b>
                    </div>
                  </div>
                </>
              ) : (
                <div className="ctx-empty">暂无上下文数据</div>
              )}
              {((thread.extStatuses && Object.keys(thread.extStatuses).length > 0) ||
                (thread.extWidgets && Object.keys(thread.extWidgets).length > 0)) && (
                <div className="ctx-ext">
                  <div className="ctx-pop-sub">插件状态</div>
                  {Object.entries(thread.extStatuses || {}).map(([k, v]) => (
                    <div key={k} className="ctx-ext-status">{v}</div>
                  ))}
                  {Object.entries(thread.extWidgets || {}).map(([k, v]) => (
                    <div key={k} className="ctx-row">
                      <span>{k}</span>
                      <b>{v}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <button className="iconbtn" title="重新加载会话" onClick={() => reloadThread(threadId)}>
          <Refresh size={15} />
        </button>
        <button
          className="iconbtn"
          title={sharing ? "正在生成分享链接…" : "分享会话（omp share 生成加密链接）"}
          disabled={!canShare || sharing}
          onClick={() => {
            setSharing(true);
            void shareThread(threadId).finally(() => setSharing(false));
          }}
        >
          {sharing ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : <Share size={15} />}
        </button>
        <button className="iconbtn" title="切换预览" onClick={togglePreview}>
          <PanelRight size={16} />
        </button>
        {secondary && (
          <button className="iconbtn" title="关闭分屏（会话保留在标签栏）" onClick={unsplitThread}>
            <Close size={15} />
          </button>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-column">
          {userRails.length > 1 && (
            <div className="msg-rail" role="navigation" aria-label="跳转到用户消息">
              {userRails.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`msg-rail-dot${railActive === r.key ? " on" : ""}`}
                  title={r.text ? `跳到：${r.text}` : "用户消息"}
                  aria-label={r.text || "用户消息"}
                  onClick={() => scrollToKey(r.key)}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHoverKey(r.key);
                    setHoverPos({ left: rect.right + 10, top: rect.top + rect.height / 2 });
                  }}
                  onMouseLeave={() => setHoverKey(null)}
                />
              ))}
            </div>
          )}
          <div className="messages">
          {headGroups.map((g) => (
            <MessageGroup key={g.key} threadId={threadId} group={g} toolRuns={thread.toolRuns} stripKey={todoInfo?.sourceKey ?? null} searchQuery={searchQuery} onPreviewImage={setPreviewImage} isLastUser={g.key === lastUserKey} canUndo={canUndo} />
          ))}
          {streaming && streamingExtends && lastGroup && (
            <MessageGroup
              key={lastGroup.key}
              threadId={threadId}
              group={{ key: lastGroup.key, role: "assistant", items: [...lastGroup.items, streaming] }}
              toolRuns={thread.toolRuns}
              streaming
              stripKey={todoInfo?.sourceKey ?? null}
              searchQuery={searchQuery}
              onPreviewImage={setPreviewImage}
              isLastUser={false}
              canUndo={canUndo}
            />
          )}
          {streaming && !streamingExtends && (
            <MessageGroup
              key={streaming.key}
              threadId={threadId}
              group={{ key: streaming.key, role: "assistant", items: [streaming] }}
              toolRuns={thread.toolRuns}
              streaming
              stripKey={todoInfo?.sourceKey ?? null}
              searchQuery={searchQuery}
              onPreviewImage={setPreviewImage}
              isLastUser={false}
              canUndo={canUndo}
            />
          )}
          {thread.error && (
            <div className="msg system">
              <div className="msg-body">⚠ {thread.error}</div>
            </div>
          )}
          </div>
        </div>
      </div>

      {todoInfo && <TodoPanel threadId={threadId} items={todoInfo.items} />}
      {subagentInfo && <SubagentPanel threadId={threadId} rows={subagentInfo.rows} />}

      <div className="composer-confirmation-region" aria-live="assertive">
        <ExtUiPromptCard threadId={threadId} />
      </div>
      <Composer threadId={threadId} />
      {hoveredRail && hoverPos && (
        <div className="msg-rail-preview" style={{ left: hoverPos.left, top: hoverPos.top }}>
          <div className="msg-rail-preview-label">用户提示词</div>
          <div className="msg-rail-preview-text">{hoveredRail.fullText || "（无文本）"}</div>
        </div>
      )}
      {previewImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={() => setPreviewImage(null)}>
          <button className="image-lightbox-close" title="关闭" onClick={() => setPreviewImage(null)}>×</button>
          <img src={previewImage} alt="图片预览" onMouseDown={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

/** Tool-run ids a message actually renders — for targeted re-render checks. */
function referencedRunIds(m: ViewMessage): string[] {
  if (!m.blocks) return [];
  const ids: string[] = [];
  for (const b of m.blocks) if (b.type === "toolCall") ids.push(b.id);
  return ids;
}

/** A visual turn: one user message, or a run of consecutive assistant messages
 *  (a whole agent round) rendered under a single avatar. */
interface MsgGroup {
  key: string;
  role: "user" | "assistant" | "system";
  items: ViewMessage[];
}

function groupMessages(messages: ViewMessage[]): MsgGroup[] {
  const groups: MsgGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (m.role === "assistant" && last && last.role === "assistant") {
      last.items.push(m);
    } else {
      groups.push({ key: m.key, role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", items: [m] });
    }
  }
  return groups;
}

/**
 * Memoized on (group identity, streaming flag, and only the tool runs this
 * group references). Past groups are immutable in the store, so during
 * streaming only the live group re-renders — not the whole history.
 */
const MessageGroup = memo(MessageGroupInner, (prev, next) => {
  if (
    prev.group !== next.group ||
    prev.threadId !== next.threadId ||
    !!prev.streaming !== !!next.streaming ||
    prev.stripKey !== next.stripKey ||
    prev.searchQuery !== next.searchQuery ||
    prev.onPreviewImage !== next.onPreviewImage ||
    prev.canUndo !== next.canUndo ||
    prev.isLastUser !== next.isLastUser
  ) {
    return false;
  }
  for (const m of prev.group.items) {
    for (const id of referencedRunIds(m)) {
      if (prev.toolRuns[id] !== next.toolRuns[id]) return false;
    }
  }
  return true;
});

/** Collapsible grouped artifact tree: edit artifacts (writes/edits) and context artifacts (reads). */
function ArtifactSection({
  editArtifacts,
  contextArtifacts,
  language,
  openArtifact,
}: {
  editArtifacts: FileArtifact[];
  contextArtifacts: FileArtifact[];
  language: string;
  openArtifact: (a: FileArtifact) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const total = editArtifacts.length + contextArtifacts.length;

  return (
    <section className="msg-artifacts" aria-label={language === "zh" ? "文件产物" : "File outputs"}>
      <div className="msg-artifacts-head" onClick={() => setCollapsed((v) => !v)} style={{ cursor: "pointer" }}>
        <span className="msg-artifacts-toggle" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        <Files size={13} />
        <span>{language === "zh" ? "文件产物" : "File outputs"}</span>
        <span className="msg-artifacts-count">{total}</span>
      </div>
      {!collapsed && (
        <div className="msg-artifacts-tree">
          {editArtifacts.length > 0 && (
            <div className="msg-artifacts-group">
              <div className="msg-artifacts-group-head">
                <span className="msg-artifacts-group-label">{language === "zh" ? "编辑产物" : "Edits"}</span>
                <span className="msg-artifacts-group-count">{editArtifacts.length}</span>
              </div>
              {editArtifacts.map((a) => (
                <ArtifactRow key={a.path.toLowerCase()} artifact={a} language={language} openArtifact={openArtifact} />
              ))}
            </div>
          )}
          {contextArtifacts.length > 0 && (
            <div className="msg-artifacts-group">
              <div className="msg-artifacts-group-head">
                <span className="msg-artifacts-group-label">{language === "zh" ? "上下文读取" : "Context reads"}</span>
                <span className="msg-artifacts-group-count">{contextArtifacts.length}</span>
              </div>
              {contextArtifacts.map((a) => (
                <ArtifactRow key={a.path.toLowerCase()} artifact={a} language={language} openArtifact={openArtifact} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ArtifactRow({ artifact, language, openArtifact }: { artifact: FileArtifact; language: string; openArtifact: (a: FileArtifact) => void }) {
  return (
    <button
      className="msg-artifact"
      title={`${language === "zh" ? "在 Omp Studio 中查看" : "View in Omp Studio"} · ${artifact.path}`}
      onClick={() => void openArtifact(artifact)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void window.pi.app.showFileContextMenu(artifact.path);
      }}
    >
      <span className="msg-artifact-icon" aria-hidden="true">
        {artifact.ext ? artifact.ext.slice(1, 5).toUpperCase() : <Files size={14} />}
      </span>
      <span className="msg-artifact-copy">
        <span className="msg-artifact-name">{artifact.name}</span>
        <span className="msg-artifact-path">{artifact.displayPath}</span>
      </span>
      <span className={`msg-artifact-action ${artifact.action}`}>
        {language === "zh"
          ? artifact.action === "created" ? "已生成" : "已更新"
          : artifact.action === "created" ? "Created" : "Updated"}
      </span>
      <PanelRight size={14} className="msg-artifact-open" />
    </button>
  );
}

function MessageGroupInner({
  threadId,
  group,
  toolRuns,
  streaming,
  stripKey,
  searchQuery,
  onPreviewImage,
  isLastUser,
  canUndo,
}: {
  threadId: string;
  group: MsgGroup;
  toolRuns: Record<string, ToolRun>;
  streaming?: boolean;
  /** Key of the message whose todo lines are lifted into the todo panel. */
  stripKey?: string | null;
  /** Active chat search query; drives <mark> highlighting when non-empty. */
  searchQuery?: string;
  /** True when this group holds the newest user message — where 撤回 lives. */
  isLastUser?: boolean;
  /** Undo availability (session persisted, settled, has a user prompt). */
  canUndo?: boolean;
  onPreviewImage: (src: string) => void;
}) {
  const openPreview = useStore((s) => s.openPreview);
  const undoLastTurn = useStore((s) => s.undoLastTurn);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const language = useStore((s) => s.config?.language || "en");
  const userAvatar = useStore((s) => s.config?.userAvatar);
  const showTokenUsage = useStore((s) => s.showTokenUsage);
  const q = (searchQuery || "").trim().toLowerCase();
  const highlightFor = (text: string) => (q && text.toLowerCase().includes(q) ? searchQuery : undefined);
  const artifacts = useMemo(
    () => (group.role === "assistant" ? collectFileArtifacts(group.items, toolRuns, cwd) : []),
    [cwd, group.items, group.role, toolRuns],
  );
  const artifactCheckKey = useMemo(() => {
    const paths = artifacts.map((artifact) => artifact.path.toLowerCase()).join("|");
    const toolStates = group.items
      .flatMap((message) => (message.blocks || []).filter((block) => block.type === "toolCall"))
      .map((block) => {
        const run = toolRuns[block.id];
        return `${block.id}:${run?.running ? "running" : run?.completed ? "done" : "pending"}:${run?.isError ? "error" : "ok"}`;
      })
      .join("|");
    return `${paths}::${toolStates}`;
  }, [artifacts, group.items, toolRuns]);
  const [artifactExists, setArtifactExists] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    if (!artifacts.length) {
      setArtifactExists({});
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(
      artifacts.map(async (artifact) => {
        const key = artifact.path.toLowerCase();
        try {
          const exists = await window.pi.app.fileExists(artifact.path);
          return [key, !!exists] as const;
        } catch {
          // Keep the historical artifact visible when an existence probe is
          // unavailable; the click handler will perform the same safe check.
          return [key, true] as const;
        }
      }),
    ).then((results) => {
      if (!cancelled) setArtifactExists(Object.fromEntries(results));
    });
    return () => {
      cancelled = true;
    };
  }, [artifactCheckKey]);

  const visibleArtifacts = artifacts.filter((artifact) => artifactExists[artifact.path.toLowerCase()] !== false);

  if (group.role === "user") {
    const m = group.items[0];
    const skillBlock = m.text ? parseSkillBlock(m.text) : null;
    return (
      <div className="msg user" data-msg-key={group.key}>
        <div className="msg-user-stack">
          <div className="msg-body">
            {m.sendKind && (
              <div className={`msg-kind ${m.sendKind}`}>{m.sendKind === "steer" ? "steering" : "follow-up"}</div>
            )}
            {skillBlock ? (
              <>
                <SkillInvocation name={skillBlock.name} />
                {skillBlock.userMessage && (
                  <div className="msg-user-text msg-user-skill-request">
                    <HighlightText text={skillBlock.userMessage} query={searchQuery} />
                  </div>
                )}
              </>
            ) : (
              m.text && (
                <div className="msg-user-text">
                  <HighlightText text={m.text} query={searchQuery} />
                </div>
              )
            )}
            {m.images && m.images.length > 0 && (
              <div className="msg-user-imgs">
                {m.images.map((im, i) => (
                  <button key={i} className="msg-user-img-button" onClick={() => onPreviewImage(im.dataUrl)} title="图片预览">
                    <img className="msg-user-img" src={im.dataUrl} alt="attachment" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="msg-user-actions">
            <button
              disabled={!m.text}
              title="复制这条用户消息"
              onClick={() => m.text && navigator.clipboard?.writeText(m.text)}
            >
              <Copy size={11} /> 复制
            </button>
            {isLastUser && (
              <button
                disabled={!canUndo}
                title="撤回最近一次对话（删除最后一条提示词及其回复，重新加载会话）"
                onClick={() => void undoLastTurn(threadId)}
              >
                <Undo size={11} /> 撤回
              </button>
            )}
          </div>
        </div>
        <div className="msg-avatar" aria-label="用户">
            {userAvatar ? (
              <img className="msg-user-avatar-img" src={userAvatar} alt="" />
            ) : (
              DEFAULT_USER_AVATAR
            )}
          </div>
      </div>
    );
  }

  if (group.role === "system") {
    const m = group.items[0];
    const isRecap = m.kind === "recap";
    return (
      <div className="msg system" data-msg-key={group.key}>
        <div className={`msg-advisory${isRecap ? " msg-advisory-recap" : ""}`}>
          {(m.severity || m.guidance || isRecap) && (
            <div className="msg-advisory-head">
              {m.severity && <span className={`msg-advisory-sev ${m.severity}`}>{m.severity}</span>}
              {isRecap && !m.severity && <span className="msg-advisory-sev recap">{m.text ? "recap" : ""}</span>}
              {m.guidance && <span className="msg-advisory-guidance">{m.guidance}</span>}
            </div>
          )}
          {m.text && <div className="msg-advisory-text">{m.text}</div>}
        </div>
      </div>
    );
  }

  // Assistant round: ONE avatar shared by every assistant message in the group.
  const last = group.items[group.items.length - 1];
  const hasBlocks = group.items.some((m) => m.blocks && m.blocks.length > 0);
  const openArtifact = async (artifact: (typeof artifacts)[number]) => {
    try {
      const exists = await window.pi.app.fileExists(artifact.path);
      if (!exists) {
        setArtifactExists((current) => ({ ...current, [artifact.path.toLowerCase()]: false }));
        return;
      }
    } catch {
      // Fall through to the normal preview path if the probe is unavailable.
    }
    openPreview(artifact.path, cwd);
  };
  return (
    <div className="msg assistant" data-msg-key={group.key}>
      <div className="msg-avatar" aria-label="Omp Studio Agent">
        <img className="msg-app-icon" src={appIconUrl} alt="" />
      </div>
      <div className="msg-body">
        {group.items.map((m) =>
          (m.blocks || []).map((b, i) =>
            b.type === "text" && m.key === stripKey ? (
              <Markdown key={`${m.key}:${i}`} text={stripTodoLines(b.text)} highlight={highlightFor(b.text)} />
            ) : (
              <BlockView key={`${m.key}:${i}`} block={b} toolRuns={toolRuns} highlight={highlightFor(b.type === "text" ? b.text : "")} />
            )
          )
        )}
        {streaming && !hasBlocks && <span className="muted">思考中</span>}
        {streaming && <span className="streaming-dot" />}
        {last.errorMessage && <div style={{ color: "#c0392b", marginTop: 6 }}>{last.errorMessage}</div>}
        {visibleArtifacts.length > 0 && (() => {
          const editArts = visibleArtifacts.filter((a) => a.kind === "edit");
          const contextArts = visibleArtifacts.filter((a) => a.kind === "context");
          return (
            <ArtifactSection
              editArtifacts={editArts}
              contextArtifacts={contextArts}
              language={language}
              openArtifact={openArtifact}
            />
          );
        })()}
        {!streaming && (
          <div className="msg-footer">
            {last.model && <span>{last.model}</span>}
            {showTokenUsage && last.usage && (last.usage.input || last.usage.output) && (
              <span className="msg-usage" title={language === "zh" ? "本轮 token 用量（输入 / 输出）" : "This turn's token usage (in / out)"}>
                ⤵ {formatTokens(last.usage.input)} ⤴ {formatTokens(last.usage.output)}
              </span>
            )}
            {last.timestamp && <span>{formatClock(last.timestamp)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Collapsible panel above the composer showing the current todo list. */
function TodoPanel({ threadId, items }: { threadId: string; items: TodoItem[] }) {
  const collapsed = useStore((s) => !!s.threads[threadId]?.todoCollapsed);
  const setTodoCollapsed = useStore((s) => s.setTodoCollapsed);
  const language = useStore((s) => s.config?.language || "en");
  const done = items.filter((i) => i.done).length;
  const active = items.find((i) => i.status === "in_progress");
  const groups = groupTodosByPhase(items);
  const showPhases = groups.some((g) => g.phase);
  const statusLabel = (status: TodoItem["status"]) => {
    if (language === "zh") {
      if (status === "in_progress") return "进行中";
      if (status === "blocked") return "阻塞";
      if (status === "done") return "完成";
      return "待办";
    }
    if (status === "in_progress") return "in progress";
    if (status === "blocked") return "blocked";
    if (status === "done") return "done";
    return "pending";
  };
  return (
    <section className={`stack-panel-wrap ${collapsed ? "collapsed" : ""}`}>
      <div className="stack-panel">
        <button
          type="button"
          className="stack-panel-head"
          aria-expanded={!collapsed}
          title={language === "zh" ? (collapsed ? "展开待办" : "收起待办") : collapsed ? "Expand todos" : "Collapse todos"}
          onClick={() => setTodoCollapsed(threadId, !collapsed)}
        >
          <span className="stack-panel-title">
            <Check size={13} />
            {language === "zh" ? "待办" : "Todos"}
          </span>
          <span className="stack-panel-count">
            {active
              ? language === "zh"
                ? `${done}/${items.length} · 进行中`
                : `${done}/${items.length} · active`
              : `${done}/${items.length}`}
          </span>
          <ChevronRight size={13} className="stack-panel-chevron" />
        </button>
        {!collapsed && (
          <div className="todo-panel-body">
            {groups.map((group, gi) => (
              <div key={`${group.phase || "_"}-${gi}`} className="todo-phase">
                {showPhases && group.phase ? (
                  <div className="todo-phase-title">
                    {group.phase}
                    <span className="todo-phase-count">
                      {` · ${group.items.filter((it) => it.done).length}/${group.items.length}`}
                    </span>
                  </div>
                ) : null}
                <ul className="todo-panel-list">
                  {group.items.map((it, i) => (
                    <li key={`${it.text}-${i}`} className={`todo-item ${it.status}`}>
                      <span className={`todo-check ${it.status}`} aria-hidden="true" title={statusLabel(it.status)}>
                        {it.status === "done" ? (
                          <Check size={9} />
                        ) : it.status === "in_progress" ? (
                          <span className="spinner" />
                        ) : it.status === "blocked" ? (
                          <Close size={9} />
                        ) : null}
                      </span>
                      <span className="todo-text">{it.text}</span>
                      {(it.status === "in_progress" || it.status === "blocked") && (
                        <span className={`todo-badge ${it.status}`}>{statusLabel(it.status)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Collapsible panel above the composer showing the current subagent batch. */
function SubagentPanel({ threadId, rows }: { threadId: string; rows: SubagentRow[] }) {
  const collapsed = useStore((s) => !!s.threads[threadId]?.subagentCollapsed);
  const setSubagentCollapsed = useStore((s) => s.setSubagentCollapsed);
  const language = useStore((s) => s.config?.language || "en");
  const states: SubagentRowState[] = rows.map((r) => subagentRowState(r.name, r.run));
  const running = states.filter((s) => s === "running").length;
  const done = states.filter((s) => s === "done").length;
  return (
    <section className={`stack-panel-wrap ${collapsed ? "collapsed" : ""}`}>
      <div className="stack-panel">
        <button
          type="button"
          className="stack-panel-head"
          aria-expanded={!collapsed}
          title={language === "zh" ? (collapsed ? "展开子任务" : "收起子任务") : collapsed ? "Expand subagents" : "Collapse subagents"}
          onClick={() => setSubagentCollapsed(threadId, !collapsed)}
        >
          <span className="stack-panel-title">
            <Branch size={13} />
            {language === "zh" ? "子任务" : "Subagents"}
          </span>
          <span className="stack-panel-count">
            {running > 0 ? `${running} ${language === "zh" ? "运行中" : "running"}` : `${done}/${rows.length}`}
          </span>
          <ChevronRight size={13} className="stack-panel-chevron" />
        </button>
        {!collapsed && (
          <ul className="subagent-list">
            {rows.map((r, i) => {
              const state = states[i];
              return (
                <li key={i} className={`subagent-item ${state === "error" ? "error" : state === "done" ? "done" : ""}`}>
                  <span className={`subagent-status ${state === "running" ? "running" : state === "error" ? "error" : state === "done" ? "done" : "pending"}`} aria-hidden="true">
                    {state === "running" ? <span className="spinner" /> : state === "error" ? <Close size={9} /> : state === "done" ? <Check size={9} /> : null}
                  </span>
                  <span className="subagent-name">{r.name || "task"}</span>
                  {r.agent && <span className="subagent-agent">{r.agent}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function BlockView({ block, toolRuns, highlight }: { block: ContentBlock; toolRuns: Record<string, ToolRun>; highlight?: string }) {
  if (block.type === "text") return <Markdown text={block.text} highlight={highlight} />;
  if (block.type === "thinking") return <Thinking text={block.thinking} />;
  return <ToolCard id={block.id} name={block.name} run={toolRuns[block.id]} />;
}

/** Plain-text match highlighting (user bubbles render as text, not markdown). */
function HighlightText({ text, query }: { text: string; query?: string }) {
  const q = (query || "").trim();
  if (!q || !text) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

const SkillInvocation = memo(function SkillInvocation({ name }: { name: string }) {
  return (
    <div className="skill-invocation" role="status" aria-label={`skill: ${name}`}>
        <span className="skill-invocation-label">skill: {name}</span>
    </div>
  );
});

const Thinking = memo(function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const displayText = normalizeTranscriptText(text);
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        思考过程 · {displayText.length} 字
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown text={displayText} />
        </div>
      )}
    </div>
  );
});

const ToolCard = memo(function ToolCard({ id, name, run }: { id: string; name: string; run?: ToolRun }) {
  const [open, setOpen] = useState(false);
  const running = run?.running;
  const argsView = renderToolArgs(name, run);
  const result = run?.resultText ?? run?.partialText ?? "";
  const status = running ? "running" : run?.isError ? "error" : run ? "done" : "queued";
  return (
    <div className="tool-card">
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        <span className="tool-name">{name}</span>
        <span className={`tool-status ${running ? "run" : run?.isError ? "err" : ""}`}>
          {running ? <span className="spinner" /> : status}
        </span>
      </div>
      {open && argsView && <div className="tool-args">{argsView}</div>}
      {open && result && (
        <div className={`tool-result ${run?.isError ? "err" : ""}`}>
          <ToolCode text={normalizeTranscriptText(result)} />
        </div>
      )}
    </div>
  );
});

/**
 * Tool arguments arrive in two forms: a parsed object after toolcall_end, or
 * an escaped JSON fragment while the call is still streaming. Keep the
 * session data untouched and normalize only the visible representation.
 */
function normalizeTranscriptText(value: unknown): string {
  if (value == null) return "";
  let text = typeof value === "string" ? value : String(value);
  text = text.replace(/\r\n?/g, "\n");

  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") text = parsed.replace(/\r\n?/g, "\n");
    } catch {
      /* Keep the original text when it is not a complete JSON string. */
    }
  }

  // A partial toolcall or older transcript may still contain transport-level
  // escape sequences. Decode them only when there are no real line breaks, so
  // source code containing a literal "\\n" remains intact.
  if (!text.includes("\n") && /\\(?:r\\n|n|r|t|\")/.test(text)) {
    text = text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }
  return text;
}

function parseToolArgs(run?: ToolRun): Record<string, unknown> | null {
  const candidate = run?.args;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    if (Object.keys(candidate).length > 0 || !run?.argsStr) return candidate as Record<string, unknown>;
  }

  const raw = typeof candidate === "string" ? candidate : run?.argsStr;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolArg(args: Record<string, unknown> | null, names: string[]): unknown {
  if (!args) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(args, name)) return args[name];
  }
  return undefined;
}

function matchesTool(name: string, names: string[]): boolean {
  const normalized = name.toLowerCase();
  return names.some((candidate) =>
    new RegExp(`(^|[-_:])${candidate}(?:$|[-_:])`, "i").test(normalized),
  );
}

function languageForPath(path: string): string | undefined {
  const ext = path.toLowerCase().split(/[./\\]/).pop() || "";
  const languages: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    py: "python",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
    java: "java",
    go: "go",
    rs: "rust",
  };
  return languages[ext];
}

function languageForTool(name: string): string | undefined {
  if (matchesTool(name, ["python"])) return "python";
  if (matchesTool(name, ["bash", "shell", "sh", "zsh", "powershell", "pwsh"])) return "bash";
  return undefined;
}

function codeFence(text: string, language?: string): string {
  const normalized = normalizeTranscriptText(text);
  const longest = Math.max(2, ...((normalized.match(/`+/g) || []).map((part) => part.length)));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language || ""}\n${normalized}${normalized.endsWith("\n") ? "" : "\n"}${fence}`;
}

function ToolCode({ text, language }: { text: string; language?: string }) {
  return <Markdown text={codeFence(text, language)} />;
}

function renderToolArgs(name: string, run?: ToolRun): ReactNode {
  if (!run) return null;
  const args = parseToolArgs(run);
  const command = toolArg(args, ["command", "cmd", "script"]);
  if (matchesTool(name, ["bash", "shell", "sh", "zsh", "exec", "execute", "command", "run", "python"])) {
    const text = typeof command === "string" ? normalizeTranscriptText(command) : typeof run.argsStr === "string" ? normalizeTranscriptText(run.argsStr) : "";
    return text ? <ToolCode text={text} language={languageForTool(name)} /> : null;
  }

  const isEdit = matchesTool(name, ["edit", "patch", "replace", "update"]);
  const isWrite = matchesTool(name, ["write", "create", "save", "export"]);
  if (isEdit || isWrite) {
    const path = normalizeTranscriptText(toolArg(args, ["path", "filePath", "file_path", "filename", "file"]));
    const oldText = normalizeTranscriptText(toolArg(args, ["oldText", "old_text", "old", "before", "original"]));
    const newText = normalizeTranscriptText(toolArg(args, ["newText", "new_text", "new", "after", "replacement", "content", "text"]));
    const patch = normalizeTranscriptText(toolArg(args, ["patch", "diff"]));
    const content = isEdit ? newText || patch : normalizeTranscriptText(toolArg(args, ["content", "text", "data", "newText", "new_text"]));
    const language = languageForPath(path);
    const sections: ReactNode[] = [];
    if (isEdit && oldText) {
      sections.push(
        <div className="tool-code-section" key="old">
          <div className="tool-code-label removed">原内容</div>
          <ToolCode text={oldText} language={language} />
        </div>,
      );
    }
    if (content) {
      sections.push(
        <div className="tool-code-section" key="new">
          <div className="tool-code-label">{isEdit ? "新内容" : "写入内容"}</div>
          <ToolCode text={content} language={language} />
        </div>,
      );
    }
    if (!sections.length && run.argsStr) {
      return <ToolCode text={normalizeTranscriptText(run.argsStr)} language="json" />;
    }
    return (
      <div className="tool-operation">
        <div className="tool-operation-title">{isEdit ? "编辑" : "写入"}{path ? ` · ${path}` : ""}</div>
        {sections}
      </div>
    );
  }

  if (args && Object.keys(args).length > 0) {
    const generic = Object.entries(args)
      .map(([key, value]) => {
        if (typeof value === "string") return `${key}:\n${normalizeTranscriptText(value)}`;
        let rendered = "";
        try {
          rendered = JSON.stringify(value, null, 2);
        } catch {
          rendered = String(value);
        }
        return `${key}: ${rendered}`;
      })
      .join("\n\n");
    return <ToolCode text={generic} />;
  }

  return run.argsStr ? <ToolCode text={normalizeTranscriptText(run.argsStr)} language="json" /> : null;
}
