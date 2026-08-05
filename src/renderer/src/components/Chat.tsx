import { memo, useEffect, useMemo, useRef, useState } from "react";
import { getDisplayThreadTitle, parseSkillBlock, useStore } from "../store";
import { Markdown } from "../lib/markdown";
import { formatClock, formatTokens } from "../lib/format";
import { collectFileArtifacts } from "../lib/artifacts";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { ContentBlock, ToolRun, ViewMessage } from "../lib/types";
import { Composer } from "./Composer";
import { ExtUiPromptCard } from "./ExtUiPromptCard";
import { Sidebar, PanelRight, Copy, ThumbUp, ThumbDown, Refresh, Edit, Folder, Files, Gauge, Branch } from "./icons";
import appIconUrl from "../../../../resources/icon.png";

export function Chat() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const thread = useStore((s) => (activeThreadId ? s.threads[activeThreadId] : null));
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePreview = useStore((s) => s.togglePreview);
  const newSessionInThread = useStore((s) => s.newSessionInThread);
  const renameThread = useStore((s) => s.renameThread);
  const switchThreadFolder = useStore((s) => s.switchThreadFolder);
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

  // auto-scroll to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (near) el.scrollTop = el.scrollHeight;
  }, [count, streaming?.blocks?.length, thread?.messages.length]);

  useEffect(() => {
    if (!previewImage) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setPreviewImage(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewImage]);

  if (!thread || !activeThreadId) return null;

  // Optimistic open: the pi process is still booting. Show the chrome plus a
  // spinner immediately instead of leaving the previous view frozen.
  if (thread.loading) {
    return (
      <section className="main">
        <div className="chat-head">
          <button className="iconbtn" title="Toggle sidebar" onClick={toggleSidebar}>
            <Sidebar size={16} />
          </button>
          <div className="chat-head-titlewrap">
            <div className="chat-head-title">{thread.sessionName || "新线程"}</div>
          </div>
          <div className="spacer" />
        </div>
        <div className="chat-loading">
          <span className="spinner" />
          正在启动 pi 进程…
        </div>
      </section>
    );
  }

  const firstUserText = thread.messages.find((m) => m.role === "user")?.text || "";
  const title = getDisplayThreadTitle(thread.sessionName, firstUserText).slice(0, 40) || "New thread";

  // Group consecutive assistant messages into one visual turn: a single agent
  // round emits many assistant messages (think -> tool -> ... -> final reply)
  // separated only by tool results, which are not rendered as bubbles. They
  // share ONE avatar; a user message starts a new group. thread.messages keeps
  // a stable identity during token streaming, so this memo only recomputes when
  // a message finalizes.
  const groups = useMemo(() => groupMessages(thread.messages), [thread.messages]);
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
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={commitRename}
            />
          ) : (
            <>
              <div className="chat-head-title" title={title} onDoubleClick={startRename}>
                {title}
              </div>
              {thread.cwd && (
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
              )}
            </>
          )}
        </div>
        {!thread.connected && (
          <span className="chat-connecting" title="pi 进程连接中；历史已可浏览，发送消息会自动等待连接完成">
            <span className="spinner" /> 连接中
          </span>
        )}
        <button className="iconbtn" title="重命名" onClick={startRename}>
          <Edit size={14} />
        </button>
        <div className="spacer" />
        <div className="ctx-wrap" ref={ctxRef}>
          <button className={`iconbtn ${ctxOpen ? "on" : ""}`} title="当前线程上下文用量" onClick={toggleCtx}>
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
            </div>
          )}
        </div>
        <button className="iconbtn" title="切换工作文件夹" onClick={() => switchThreadFolder(activeThreadId)}>
          <Folder size={15} />
        </button>
        <button className="iconbtn" title="新会话" onClick={() => newSessionInThread(activeThreadId)}>
          <Refresh size={15} />
        </button>
        <button className="iconbtn" title="切换预览" onClick={togglePreview}>
          <PanelRight size={16} />
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        <div className="messages">
          {headGroups.map((g) => (
            <MessageGroup key={g.key} threadId={activeThreadId} group={g} toolRuns={thread.toolRuns} locked={thread.isStreaming} onPreviewImage={setPreviewImage} />
          ))}
          {streaming && streamingExtends && lastGroup && (
            <MessageGroup
              key={lastGroup.key}
              threadId={activeThreadId}
              group={{ key: lastGroup.key, role: "assistant", items: [...lastGroup.items, streaming] }}
              toolRuns={thread.toolRuns}
              locked
              streaming
              onPreviewImage={setPreviewImage}
            />
          )}
          {streaming && !streamingExtends && (
            <MessageGroup
              key={streaming.key}
              threadId={activeThreadId}
              group={{ key: streaming.key, role: "assistant", items: [streaming] }}
              toolRuns={thread.toolRuns}
              locked
              streaming
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
  role: "user" | "assistant";
  items: ViewMessage[];
}

function groupMessages(messages: ViewMessage[]): MsgGroup[] {
  const groups: MsgGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (m.role === "assistant" && last && last.role === "assistant") {
      last.items.push(m);
    } else {
      groups.push({ key: m.key, role: m.role === "assistant" ? "assistant" : "user", items: [m] });
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
    prev.locked !== next.locked ||
    !!prev.streaming !== !!next.streaming
    || prev.onPreviewImage !== next.onPreviewImage
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
  locked,
  streaming,
  onPreviewImage,
}: {
  threadId: string;
  group: MsgGroup;
  toolRuns: Record<string, ToolRun>;
  locked?: boolean;
  streaming?: boolean;
  onPreviewImage: (src: string) => void;
}) {
  const forkThreadFromAgentReply = useStore((s) => s.forkThreadFromAgentReply);
  const cloneThread = useStore((s) => s.cloneThread);
  const openPreview = useStore((s) => s.openPreview);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const language = useStore((s) => s.config?.language || "en");
  const [branching, setBranching] = useState<"fork" | "clone" | null>(null);
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
  const runBranchAction = async (kind: "fork" | "clone") => {
    if (locked || branching || !last.branchEntryId) return;
    setBranching(kind);
    try {
      if (kind === "fork") await forkThreadFromAgentReply(threadId, last.branchEntryId);
      else await cloneThread(threadId, last.branchEntryId);
    } finally {
      setBranching(null);
    }
  };
  return (
    <div className="msg assistant">
      <div className="msg-avatar" aria-label="Pi Studio Agent">
        <img className="msg-app-icon" src={appIconUrl} alt="" />
      </div>
      <div className="msg-body">
        {group.items.map((m) =>
          (m.blocks || []).map((b, i) => <BlockView key={`${m.key}:${i}`} block={b} toolRuns={toolRuns} />)
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
                  title={`${language === "zh" ? "在 Pi Studio 中查看" : "View in Pi Studio"} · ${artifact.path}`}
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
            <span className="msg-actions">
              <button title="Copy" onClick={() => navigator.clipboard?.writeText(plainOfGroup(group))}>
                <Copy size={12} />
              </button>
              <button title="Good">
                <ThumbUp size={12} />
              </button>
              <button title="Bad">
                <ThumbDown size={12} />
              </button>
            </span>
            <span className="msg-branch-actions" aria-label="从此 Agent 回复分支">
              <button
                disabled={locked || !!branching || !last.branchEntryId}
                title={last.branchEntryId ? "从这条 Agent 回复开始创建新分支" : "连接并保存会话后可 Fork"}
                onClick={() => runBranchAction("fork")}
              >
                <Branch size={11} /> {branching === "fork" ? "Forking…" : "Fork"}
              </button>
              <button
                disabled={locked || !!branching || !last.branchEntryId}
                title={last.branchEntryId ? "复制截至这条 Agent 回复的分支" : "连接并保存会话后可 Clone"}
                onClick={() => runBranchAction("clone")}
              >
                <Copy size={11} /> {branching === "clone" ? "Cloning…" : "Clone"}
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function plainOfGroup(g: MsgGroup): string {
  return g.items
    .map((m) =>
      (m.blocks || [])
        .map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : ""))
        .filter(Boolean)
        .join("\n\n")
    )
    .filter(Boolean)
    .join("\n\n");
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
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>›</span>
        思考过程 · {text.length} 字
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
});

const ToolCard = memo(function ToolCard({ id, name, run }: { id: string; name: string; run?: ToolRun }) {
  const [open, setOpen] = useState(false);
  const running = run?.running;
  const args = run?.args && Object.keys(run.args).length ? JSON.stringify(run.args, null, 2) : run?.argsStr || "";
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
      {open && args && <div className="tool-args">{args}</div>}
      {open && result && <div className={`tool-result ${run?.isError ? "err" : ""}`}>{result}</div>}
    </div>
  );
});
