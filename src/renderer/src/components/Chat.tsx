import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDisplayThreadTitle, parseSkillBlock, useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { formatClock, formatTokens } from "../lib/format";
import { collectFileArtifacts } from "../lib/artifacts";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { ContentBlock, ToolRun, ViewMessage } from "../lib/types";
import { Composer } from "./Composer";
import { ExtUiPromptCard } from "./ExtUiPromptCard";
import { Sidebar, PanelRight, Copy, Refresh, Edit, Folder, Files, Gauge, Branch, Check, ChevronRight, Close, Undo } from "./icons";
import { ThreadTabs } from "./ThreadTabs";
import appIconUrl from "../../../../resources/icon.png";

/** One extracted markdown checkbox item. */
export interface TodoItem {
  done: boolean;
  text: string;
}

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
    if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
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

interface TaskItem {
  name?: string;
  agent?: string;
}

/** Narrow omp's `task` tool payload (tasks[] batch + intent) without casts. */
function taskArgsOf(raw: unknown): { tasks: TaskItem[]; i: string } {
  if (!raw || typeof raw !== "object") return { tasks: [], i: "" };
  const tasks: TaskItem[] = [];
  if ("tasks" in raw && Array.isArray(raw.tasks)) {
    for (const t of raw.tasks) {
      if (!t || typeof t !== "object") continue;
      if (!("name" in t) && !("agent" in t)) continue;
      tasks.push({
        name: "name" in t && typeof t.name === "string" ? t.name : undefined,
        agent: "agent" in t && typeof t.agent === "string" ? t.agent : undefined,
      });
    }
  }
  const i = "i" in raw && typeof raw.i === "string" ? raw.i : "";
  return { tasks, i };
}

/** Parse the subagent rows of a `task` tool call, falling back to the batch intent. */
function subagentRowsOf(block: ToolCallBlock, run: ToolRun): SubagentRow[] {
  const { tasks, i } = taskArgsOf(block.arguments);
  if (tasks.length) return tasks.map((t) => ({ name: t.name || "", agent: t.agent, run }));
  return [{ name: i, run }];
}

export function Chat() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const thread = useStore((s) => (s.activeThreadId ? s.threads[s.activeThreadId] : null));
  const chatScrollSeq = useStore((s) => s.chatScrollSeq);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePreview = useStore((s) => s.togglePreview);
  const reloadThread = useStore((s) => s.reloadThread);
  const undoLastTurn = useStore((s) => s.undoLastTurn);
  const renameThread = useStore((s) => s.renameThread);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // context-usage popover
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxStats, setCtxStats] = useState<any>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  useOutsideClose(ctxRef, ctxOpen, () => setCtxOpen(false));

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
    if (!el || !activeThreadId || thread?.loading) return;
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
  }, [activeThreadId, chatScrollSeq, thread?.loading]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setPreviewImage(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  // Must stay above any early return: thread.loading used to skip this hook and
  // white-screen the app (React hook-order violation).
  const groups = useMemo(() => groupMessages(thread?.messages || []), [thread?.messages]);

  // Current todos = checkbox list from the newest assistant message (committed
  // or streaming) that contains one. That message's list is stripped from the
  // stream and shown in the collapsible panel above the composer.
  const todoInfo = useMemo<TodoInfo | null>(() => {
    const msgs = thread ? [...thread.messages, ...(streaming ? [streaming] : [])] : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const text = (m.blocks || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const items = extractTodos(text);
      if (items) return { sourceKey: m.key, items };
    }
    return null;
  }, [thread?.messages, streaming]);

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

  if (!thread || !activeThreadId) return null;

  // Optimistic open: the omp process is still booting. Show the chrome plus a
  // spinner immediately instead of leaving the previous view frozen.
  if (thread.loading) {
    return (
      <section className="main">
        <ThreadTabs />
        <div className="chat-head">
          <button className="iconbtn" title="Toggle sidebar" onClick={toggleSidebar}>
            <Sidebar size={16} />
          </button>
          <div className="chat-head-titlewrap">
            <div key={activeThreadId} className="chat-head-title">{thread.sessionName || "新会话"}</div>
          </div>
          <div className="spacer" />
        </div>
        <div className="chat-loading">
          <span className="spinner" />
          正在启动 omp 进程…
        </div>
      </section>
    );
  }

  const firstUserText = thread.messages.find((m) => m.role === "user")?.text || "";
  const title = getDisplayThreadTitle(thread.sessionName, firstUserText).slice(0, 40) || "新会话";

  // Undo needs a persisted session with at least one user prompt, and must wait
  // for any in-flight reply to settle before the file can be truncated.
  const canUndo = !thread.isStreaming && !!thread.sessionFile && thread.messages.some((m) => m.role === "user");

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
    if (v) renameThread(activeThreadId, v);
  };

  const cancelRename = () => {
    setEditing(false);
  };

  const loadCtx = async () => {
    if (!activeThreadId) return;
    setCtxLoading(true);
    try {
      const id = await useStore.getState().ensureConnected(activeThreadId);
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

  return (
    <section className="main">
      <ThreadTabs />
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
              <div key={activeThreadId} className="chat-head-title" title={title} onDoubleClick={startRename}>
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
        <button
          className="iconbtn"
          title="撤销最近一次对话（删除最后一条提示词及其回复，重新加载会话）"
          disabled={!canUndo}
          onClick={() => void undoLastTurn(activeThreadId)}
        >
          <Undo size={15} />
        </button>
        <button className="iconbtn" title="重新加载会话" onClick={() => reloadThread(activeThreadId)}>
          <Refresh size={15} />
        </button>
        <button className="iconbtn" title="切换预览" onClick={togglePreview}>
          <PanelRight size={16} />
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="messages">
          {headGroups.map((g) => (
            <MessageGroup key={g.key} threadId={activeThreadId} group={g} toolRuns={thread.toolRuns} stripKey={todoInfo?.sourceKey ?? null} onPreviewImage={setPreviewImage} />
          ))}
          {streaming && streamingExtends && lastGroup && (
            <MessageGroup
              key={lastGroup.key}
              threadId={activeThreadId}
              group={{ key: lastGroup.key, role: "assistant", items: [...lastGroup.items, streaming] }}
              toolRuns={thread.toolRuns}
              streaming
              stripKey={todoInfo?.sourceKey ?? null}
              onPreviewImage={setPreviewImage}
            />
          )}
          {streaming && !streamingExtends && (
            <MessageGroup
              key={streaming.key}
              threadId={activeThreadId}
              group={{ key: streaming.key, role: "assistant", items: [streaming] }}
              toolRuns={thread.toolRuns}
              streaming
              stripKey={todoInfo?.sourceKey ?? null}
              onPreviewImage={setPreviewImage}
            />
          )}
          {thread.error && (
            <div className="msg system">
              <div className="msg-body">⚠ {thread.error}</div>
            </div>
          )}
        </div>
      </div>

      {todoInfo && <TodoPanel threadId={activeThreadId} items={todoInfo.items} />}
      {subagentInfo && <SubagentPanel threadId={activeThreadId} rows={subagentInfo.rows} />}

      <div className="composer-confirmation-region" aria-live="assertive">
        <ExtUiPromptCard threadId={activeThreadId} />
      </div>
      <Composer threadId={activeThreadId} />
      {previewImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={() => setPreviewImage(null)}>
          <button className="image-lightbox-close" title="关闭" onClick={() => setPreviewImage(null)}>×</button>
          <img src={previewImage} alt="图片预览" onMouseDown={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
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
    prev.onPreviewImage !== next.onPreviewImage
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

function MessageGroupInner({
  threadId,
  group,
  toolRuns,
  streaming,
  stripKey,
  onPreviewImage,
}: {
  threadId: string;
  group: MsgGroup;
  toolRuns: Record<string, ToolRun>;
  streaming?: boolean;
  /** Key of the message whose todo lines are lifted into the todo panel. */
  stripKey?: string | null;
  onPreviewImage: (src: string) => void;
}) {
  const openPreview = useStore((s) => s.openPreview);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const language = useStore((s) => s.config?.language || "en");
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
      <div className="msg user">
        <div className="msg-user-stack">
          <div className="msg-body">
            {m.sendKind && (
              <div className={`msg-kind ${m.sendKind}`}>{m.sendKind === "steer" ? "steering" : "follow-up"}</div>
            )}
            {skillBlock ? (
              <>
                <SkillInvocation name={skillBlock.name} />
                {skillBlock.userMessage && <div className="msg-user-text msg-user-skill-request">{skillBlock.userMessage}</div>}
              </>
            ) : (
              m.text && <div className="msg-user-text">{m.text}</div>
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
          </div>
        </div>
        <div className="msg-avatar" aria-label="用户">
          <span className="msg-user-character" aria-hidden="true">
            🧑
          </span>
        </div>
      </div>
    );
  }

  if (group.role === "system") {
    const m = group.items[0];
    return (
      <div className="msg system">
        <div className="msg-advisory">
          {(m.severity || m.guidance) && (
            <div className="msg-advisory-head">
              {m.severity && <span className={`msg-advisory-sev ${m.severity}`}>{m.severity}</span>}
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
    <div className="msg assistant">
      <div className="msg-avatar" aria-label="Omp Studio Agent">
        <img className="msg-app-icon" src={appIconUrl} alt="" />
      </div>
      <div className="msg-body">
        {group.items.map((m) =>
          (m.blocks || []).map((b, i) =>
            b.type === "text" && m.key === stripKey ? (
              <Markdown key={`${m.key}:${i}`} text={stripTodoLines(b.text)} />
            ) : (
              <BlockView key={`${m.key}:${i}`} block={b} toolRuns={toolRuns} />
            )
          )
        )}
        {streaming && !hasBlocks && <span className="muted">思考中</span>}
        {streaming && <span className="streaming-dot" />}
        {last.errorMessage && <div style={{ color: "#c0392b", marginTop: 6 }}>{last.errorMessage}</div>}
        {visibleArtifacts.length > 0 && (
          <section className="msg-artifacts" aria-label={language === "zh" ? "文件产物" : "File outputs"}>
            <div className="msg-artifacts-head">
              <Files size={13} />
              <span>{language === "zh" ? "文件产物" : "File outputs"}</span>
              <span className="msg-artifacts-count">{visibleArtifacts.length}</span>
            </div>
            <div className="msg-artifacts-list">
              {visibleArtifacts.map((artifact) => (
                <button
                  key={artifact.path.toLowerCase()}
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
                      ? artifact.action === "created"
                        ? "已生成"
                        : "已更新"
                      : artifact.action === "created"
                        ? "Created"
                        : "Updated"}
                  </span>
                  <PanelRight size={14} className="msg-artifact-open" />
                </button>
              ))}
            </div>
          </section>
        )}
        {!streaming && (
          <div className="msg-footer">
            {last.model && <span>{last.model}</span>}
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
            {done}/{items.length}
          </span>
          <ChevronRight size={13} className="stack-panel-chevron" />
        </button>
        {!collapsed && (
          <ul className="todo-panel-list">
            {items.map((it, i) => (
              <li key={i} className={`todo-item ${it.done ? "done" : ""}`}>
                <span className={`todo-check ${it.done ? "checked" : ""}`} aria-hidden="true">
                  {it.done && <Check size={9} />}
                </span>
                <span className="todo-text">{it.text}</span>
              </li>
            ))}
          </ul>
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
  const running = rows.filter((r) => r.run.running).length;
  const done = rows.filter((r) => r.run.completed && !r.run.isError).length;
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
            {rows.map((r, i) => (
              <li key={i} className={`subagent-item ${r.run.isError ? "error" : r.run.completed ? "done" : ""}`}>
                <span className={`subagent-status ${r.run.running ? "running" : r.run.isError ? "error" : r.run.completed ? "done" : "pending"}`} aria-hidden="true">
                  {r.run.running ? <span className="spinner" /> : r.run.isError ? <Close size={9} /> : r.run.completed ? <Check size={9} /> : null}
                </span>
                <span className="subagent-name">{r.name || "task"}</span>
                {r.agent && <span className="subagent-agent">{r.agent}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function BlockView({ block, toolRuns }: { block: ContentBlock; toolRuns: Record<string, ToolRun> }) {
  if (block.type === "text") return <Markdown text={block.text} />;
  if (block.type === "thinking") return <Thinking text={block.thinking} />;
  return <ToolCard id={block.id} name={block.name} run={toolRuns[block.id]} />;
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
