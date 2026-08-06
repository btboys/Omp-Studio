import { create } from "zustand";
import type {
  AppConfig,
  AppRuntime,
  ArchivedThread,
  AutomationTask,
  ContentBlock,
  ExtUiRequest,
  FileNode,
  ModelInfo,
  PendingFollowUp,
  PermissionLevel,
  PluginPackage,
  PreviewPayload,
  ProjectSummary,
  SkillInfo,
  ThreadState,
  Toast,
  ToolRun,
  ViewMessage,
} from "./lib/types";
import { cleanOutput, extensionsAlreadyLatest, hasLibuvAssertion, lastLine, stripAnsi } from "./lib/update";

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

let _c = 0;
const uid = () => `${Date.now().toString(36)}-${(_c++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage?: string;
}

/** Pi expands /skill:name into a structured user-message block. */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined,
  };
}

/** Replace Pi's expanded skill envelope with the actual user request for
 * titles and previews. A skill without extra text falls back to its name. */
export function getDisplayUserPrompt(text: string): string {
  const skill = parseSkillBlock(text);
  return skill ? skill.userMessage || `skill: ${skill.name}` : text;
}

export function getDisplayThreadTitle(sessionName: string | null | undefined, promptText: string): string {
  const name = (sessionName || "").trim();
  const prompt = getDisplayUserPrompt(promptText).trim();
  return name && !/^<skill(?:\s|>)/i.test(name) ? name : prompt;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pi intentionally delays creating a new session's JSONL file until the first
 * assistant message exists. The sidebar is disk-backed, so without this merge
 * a successfully accepted user prompt remains invisible while the agent works.
 *
 * Add live sessions that already contain a user prompt as transient summaries.
 * Once Pi flushes the JSONL, the matching disk summary wins automatically.
 */
function mergeLiveThreadsIntoProjects(
  projects: ProjectSummary[],
  live: Record<string, ThreadState>,
  archivedProjects: string[] = [],
  archivedThreads: ArchivedThread[] = [],
): ProjectSummary[] {
  const archived = new Set(archivedProjects.map((cwd) => cwd.toLowerCase()));
  const archivedThreadFiles = new Set(archivedThreads.map((thread) => thread.file.toLowerCase()));
  const next = projects.map((project) => ({
    ...project,
    threads: project.threads.filter((thread) => !archivedThreadFiles.has(thread.file.toLowerCase())),
  }));
  const byCwd = new Map(next.map((project) => [project.cwd.toLowerCase(), project]));

  for (const [threadId, thread] of Object.entries(live)) {
    if (archived.has(thread.cwd.toLowerCase())) continue;
    const file = thread.sessionFile || threadId;
    if (!file || file.startsWith("opening-") || file.startsWith("boot:")) continue;
    if (archivedThreadFiles.has(file.toLowerCase())) continue;
    const firstUser = thread.messages.find((message) => message.role === "user");
    if (!firstUser) continue;

    let project = byCwd.get(thread.cwd.toLowerCase());
    if (!project) {
      const name = thread.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || thread.cwd;
      project = { cwd: thread.cwd, name, threads: [] };
      next.unshift(project);
      byCwd.set(thread.cwd.toLowerCase(), project);
    }
    if (project.threads.some((summary) => summary.file === file)) continue;

    const userMessages = thread.messages.filter((message) => message.role === "user");
    const lastUser = userMessages[userMessages.length - 1] || firstUser;
    const firstText = getDisplayUserPrompt(firstUser.text || "").trim();
    project.threads.unshift({
      file,
      id: file,
      title: getDisplayThreadTitle(thread.sessionName, firstText).slice(0, 80) || "新线程",
      preview: firstText.slice(0, 120) || (firstUser.images?.length ? "图片消息" : ""),
      updatedAt: lastUser.timestamp || Date.now(),
      messageCount: thread.messages.filter((message) => message.role === "user" || message.role === "assistant").length,
    });
  }
  return next;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

function imagesOfContent(content: unknown): { dataUrl: string; mimeType: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { dataUrl: string; mimeType: string }[] = [];
  for (const b of content as any[]) {
    if (b && b.type === "image" && b.data) out.push({ dataUrl: `data:${b.mimeType || "image/png"};base64,${b.data}`, mimeType: b.mimeType || "image/png" });
  }
  return out;
}

function blocksOfContent(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content as any[]) {
    if (!b) continue;
    if (b.type === "text") out.push({ type: "text", text: b.text || "" });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking || "" });
    else if (b.type === "toolCall") out.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.arguments || {} });
  }
  return out;
}

function addText(blocks: ContentBlock[], delta: string): ContentBlock[] {
  const b = [...blocks];
  const last = b[b.length - 1];
  if (last && last.type === "text") b[b.length - 1] = { ...last, text: last.text + delta };
  else b.push({ type: "text", text: delta });
  return b;
}
function addThinking(blocks: ContentBlock[], delta: string): ContentBlock[] {
  const b = [...blocks];
  const last = b[b.length - 1];
  if (last && last.type === "thinking") b[b.length - 1] = { ...last, thinking: last.thinking + delta };
  else b.push({ type: "thinking", thinking: delta });
  return b;
}

const newAssistant = (key?: string): ViewMessage => ({ key: key || `a-${uid()}`, role: "assistant", blocks: [], timestamp: Date.now() });

/** Match visible user/assistant messages to Pi's stable session-entry ids.
 * Text plus branch order handles repeated content without leaking ids from an
 * inactive branch. */
function attachBranchEntryIds(
  messages: ViewMessage[],
  branchMessages: { entryId: string; role: "user" | "assistant"; text: string }[] | undefined,
): ViewMessage[] {
  if (!branchMessages?.length) return messages;
  let cursor = 0;
  return messages.map((message) => {
    if (message.role !== "user" && message.role !== "assistant") return message;
    const text =
      message.role === "user"
        ? message.text || ""
        : (message.blocks || []).map((block) => (block.type === "text" ? block.text : "")).filter(Boolean).join("\n");
    let match = -1;
    for (let i = cursor; i < branchMessages.length; i++) {
      if (branchMessages[i]?.role === message.role && branchMessages[i]?.text === text) {
        match = i;
        break;
      }
    }
    if (match < 0) {
      for (let i = cursor; i < branchMessages.length; i++) {
        if (branchMessages[i]?.role === message.role) {
          match = i;
          break;
        }
      }
    }
    if (match < 0) return message;
    cursor = match + 1;
    return { ...message, branchEntryId: branchMessages[match].entryId };
  });
}

/** Convert a flat list of pi AgentMessages into renderable views + initial tool runs. */
function historyToView(
  messages: any[],
  branchMessages?: { entryId: string; role: "user" | "assistant"; text: string }[],
): { views: ViewMessage[]; toolRuns: Record<string, ToolRun> } {
  const toolResultById: Record<string, { text: string; isError: boolean }> = {};
  for (const m of messages || []) {
    if (m?.role === "toolResult" && m.toolCallId) {
      toolResultById[m.toolCallId] = { text: textOfContent(m.content), isError: !!m.isError };
    }
  }
  const views: ViewMessage[] = [];
  const toolRuns: Record<string, ToolRun> = {};
  (messages || []).forEach((m, i) => {
    if (!m) return;
    if (m.role === "user") {
      views.push({ key: `hu-${i}`, role: "user", text: textOfContent(m.content), images: imagesOfContent(m.content), timestamp: m.timestamp });
    } else if (m.role === "assistant") {
      const blocks = blocksOfContent(m.content);
      for (const b of blocks) {
        if (b.type === "toolCall") {
          const tr = toolResultById[b.id];
          toolRuns[b.id] = {
            id: b.id,
            name: b.name,
            args: b.arguments,
            running: false,
            completed: !!tr,
            isError: tr?.isError,
            resultText: tr?.text,
          };
        }
      }
      views.push({
        key: `ha-${i}`,
        role: "assistant",
        blocks,
        timestamp: m.timestamp,
        provider: m.provider,
        model: m.model,
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
      });
    }
  });
  return { views: attachBranchEntryIds(views, branchMessages), toolRuns };
}

function pendingToArgs(p: PendingFollowUp): {
  imgs?: { data: string; mimeType: string }[];
  atts?: { abs: string; name: string }[];
} {
  const imgs = p.images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
  const atts = p.files.map((f) => ({ abs: f.abs, name: f.name }));
  return { imgs: imgs.length ? imgs : undefined, atts: atts.length ? atts : undefined };
}

function emptyThread(cwd: string): ThreadState {
  return {
    cwd,
    sessionFile: null,
    sessionName: null,
    model: null,
    models: [],
    thinking: "off",
    levels: ["off"],
    commands: [],
    isStreaming: false,
    messages: [],
    streaming: null,
    toolRuns: {},
    permission: "sandbox",
  };
}

function threadFromResponse(res: any, fallback: ThreadState, pendingEditorText?: string): ThreadState {
  const { views, toolRuns } = historyToView(res.messages || [], res.branchMessages || []);
  return {
    ...emptyThread(res.cwd || fallback.cwd),
    sessionFile: res.sessionFile,
    sessionName: res.sessionName,
    model: res.model,
    models: res.models || fallback.models || [],
    thinking: res.thinkingLevel || fallback.thinking || "off",
    levels: fallback.levels || ["off"],
    commands: res.commands || [],
    connected: true,
    isStreaming: !!res.isStreaming,
    messages: views,
    toolRuns,
    permission: res.permission || fallback.permission || "sandbox",
    pendingEditorText,
  };
}

/* ------------------------------------------------------------------ *
 * Event reducer (one thread)
 * ------------------------------------------------------------------ */

function reduceThread(t: ThreadState, event: any): ThreadState {
  if (!event || typeof event !== "object") return t;
  switch (event.type) {
    case "agent_start":
      return { ...t, isStreaming: true, error: undefined };
    case "agent_settled": {
      // If a streaming assistant message never got message_end, finalize it.
      const streaming = t.streaming;
      if (!streaming) return { ...t, isStreaming: false };
      return { ...t, isStreaming: false, streaming: null, messages: [...t.messages, streaming] };
    }
    case "message_start": {
      const m = event.message;
      if (!m) return t;
      if (m.role === "user") {
        const serverText = textOfContent(m.content);
        const serverImages = imagesOfContent(m.content);
        let optimisticIndex = -1;
        for (let i = t.messages.length - 1; i >= 0; i--) {
          const candidate = t.messages[i];
          if (!candidate?.key.startsWith("opt-")) continue;
          if (!serverText || candidate.text === serverText) {
            optimisticIndex = i;
            break;
          }
        }
        if (optimisticIndex >= 0) {
          // Connection remaps and concurrent events may append another message
          // after this bubble. Promote the matching optimistic item in place,
          // retaining local image data if the live Pi event omits its payload.
          const optimistic = t.messages[optimisticIndex];
          const promoted: ViewMessage = {
            ...optimistic,
            key: `u-${uid()}`,
            text: serverText || optimistic.text,
            images: serverImages.length ? serverImages : optimistic.images,
            timestamp: m.timestamp,
          };
          const messages = [...t.messages];
          messages[optimisticIndex] = promoted;
          return { ...t, messages };
        }
        const view: ViewMessage = { key: `u-${uid()}`, role: "user", text: serverText, images: serverImages, timestamp: m.timestamp };
        return { ...t, messages: [...t.messages, view] };
      }
      if (m.role === "assistant") {
        return { ...t, streaming: newAssistant() };
      }
      return t;
    }
    case "message_end": {
      const m = event.message;
      if (m?.role === "assistant" && t.streaming) {
        const final: ViewMessage = {
          ...t.streaming,
          provider: m.provider || t.streaming.provider,
          model: m.model || t.streaming.model,
          stopReason: m.stopReason,
          errorMessage: m.errorMessage,
          timestamp: m.timestamp || t.streaming.timestamp,
        };
        return { ...t, streaming: null, messages: [...t.messages, final] };
      }
      return t;
    }
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (!ame) return t;
      const s = t.streaming || newAssistant();
      let blocks = s.blocks || [];
      // Copy-on-write: text/thinking deltas (the overwhelmingly common case)
      // must NOT create a new toolRuns object, or every memoized consumer of
      // toolRuns re-renders on every token.
      let runs = t.toolRuns;
      switch (ame.type) {
        case "text_delta":
          blocks = addText(blocks, ame.delta || "");
          break;
        case "thinking_delta":
          blocks = addThinking(blocks, ame.delta || "");
          break;
        case "toolcall_start": {
          const ci = ame.contentIndex;
          const partial = ame.partial?.content?.[ci];
          const id = ame.toolCall?.id || partial?.id || `tc-${ci ?? uid()}`;
          const name = ame.toolCall?.name || partial?.name || "tool";
          blocks = [...blocks, { type: "toolCall", id, name, arguments: {} }];
          runs = { ...runs };
          if (!runs[id]) runs[id] = { id, name, args: {}, running: false, argsStr: "" };
          break;
        }
        case "toolcall_delta": {
          const id = ame.toolCall?.id || ame.partial?.content?.[ame.contentIndex]?.id;
          if (id) {
            const r = runs[id] || { id, name: "tool", args: {}, running: false, argsStr: "" };
            runs = { ...runs, [id]: { ...r, argsStr: (r.argsStr || "") + (ame.delta || "") } };
          }
          break;
        }
        case "toolcall_end": {
          const id = ame.toolCall?.id;
          const r = id ? runs[id] : undefined;
          if (id && r?.argsStr) {
            try {
              const parsed = JSON.parse(r.argsStr);
              runs = { ...runs, [id]: { ...r, args: parsed } };
              blocks = blocks.map((b) => (b.type === "toolCall" && b.id === id ? { ...b, arguments: parsed } : b));
            } catch {
              /* leave as-is */
            }
          }
          break;
        }
        default:
          break;
      }
      if (blocks === s.blocks && runs === t.toolRuns && s === t.streaming) return t;
      return { ...t, streaming: { ...s, blocks }, toolRuns: runs };
    }
    case "tool_execution_start": {
      const id = event.toolCallId;
      if (!id) return t;
      const prev = t.toolRuns[id] || { id, name: event.toolName || "tool", args: {}, running: false };
      return {
        ...t,
        toolRuns: {
          ...t.toolRuns,
          [id]: { ...prev, name: event.toolName || prev.name, args: event.args || prev.args, running: true, completed: false },
        },
      };
    }
    case "tool_execution_update": {
      const id = event.toolCallId;
      if (!id) return t;
      const prev = t.toolRuns[id] || { id, name: event.toolName || "tool", args: {}, running: true };
      return { ...t, toolRuns: { ...t.toolRuns, [id]: { ...prev, partialText: textOfContent(event.partialResult?.content) } } };
    }
    case "tool_execution_end": {
      const id = event.toolCallId;
      if (!id) return t;
      const prev = t.toolRuns[id] || { id, name: event.toolName || "tool", args: {}, running: false };
      return {
        ...t,
        toolRuns: {
          ...t.toolRuns,
          [id]: {
            ...prev,
            running: false,
            completed: true,
            isError: !!event.isError,
            resultText: textOfContent(event.result?.content),
            partialText: undefined,
          },
        },
      };
    }
    default:
      return t;
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

interface FileTreeEntry {
  nodes: FileNode[];
  loaded: boolean;
  expanded: boolean;
}

interface PiStore {
  // app
  config: AppConfig | null;
  runtime: AppRuntime | null;
  projects: ProjectSummary[];
  projectsLoading: boolean;

  // layout
  sidebarOpen: boolean;
  previewOpen: boolean;
  /** Preview occupies the chat workspace while preserving the mounted chat state. */
  previewExpanded: boolean;
  sidebarTab: "threads" | "files";

  // projects / threads
  activeProjectCwd: string | null;
  expandedProjects: Record<string, boolean>;
  openThreadIds: string[];
  activeThreadId: string | null;
  threads: Record<string, ThreadState>;

  // files / preview
  fileTree: Record<string, FileTreeEntry>;
  previewPath: string | null;
  previewRoot: string | null;
  previewPayload: PreviewPayload | null;
  previewLoading: boolean;

  // overlay
  toasts: Toast[];
  extuiQueue: { threadId: string; request: ExtUiRequest }[];

  // actions
  bootstrap: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  openProjectFolder: () => Promise<void>;
  unpinProject: (cwd: string) => Promise<void>;
  archiveProject: (cwd: string) => Promise<void>;
  restoreProject: (cwd: string) => Promise<void>;
  archiveThread: (cwd: string, file: string, title?: string) => Promise<void>;
  restoreThread: (file: string) => Promise<void>;
  toggleProject: (cwd: string) => void;
  setActiveProject: (cwd: string) => void;

  openThread: (cwd: string, sessionFile?: string, permission?: PermissionLevel) => Promise<string | null>;
  /** Ensure a live pi process backs the thread (adopting the warm spare).
   *  Resolves with the thread id, or null if the connection failed. Safe to
   *  call repeatedly: concurrent calls share one in-flight connect. */
  ensureConnected: (threadId: string) => Promise<string | null>;
  /** Create a new thread in the active project, prompting for a folder if none is open. */
  newTask: () => Promise<void>;
  closeThread: (id: string) => Promise<void>;
  setActiveThread: (id: string) => void;
  sendPrompt: (threadId: string, text: string, images?: { data: string; mimeType: string }[], attachments?: { abs: string; name: string }[], mode?: "steer" | "followUp") => Promise<void>;
  setPendingFollowUp: (threadId: string, pending: PendingFollowUp | null) => void;
  sendPendingSteering: (threadId: string) => Promise<void>;
  abortThread: (id: string) => Promise<void>;
  refreshOpenThreadModels: () => Promise<void>;
  setModel: (id: string, provider: string, modelId: string) => Promise<void>;
  setThinking: (id: string, level: string) => Promise<void>;
  newSessionInThread: (id: string) => Promise<void>;
  forkThreadFromAgentReply: (id: string, entryId: string) => Promise<void>;
  cloneThread: (id: string, entryId: string) => Promise<void>;
  renameThread: (id: string, name: string) => Promise<void>;

  setSidebarTab: (t: "threads" | "files") => void;
  toggleSidebar: () => void;
  togglePreview: () => void;
  togglePreviewExpanded: () => void;
  loadFileTree: (cwd: string, rel?: string) => Promise<void>;
  toggleFolder: (cwd: string, rel: string) => void;
  openPreview: (abs: string, projectRoot?: string) => Promise<void>;
  closePreview: () => void;

  pushToast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: string) => void;

  handleEvent: (threadId: string, event: any) => void;
  handleExtUi: (threadId: string, req: ExtUiRequest) => void;
  respondExtUi: (threadId: string, id: string, payload: Record<string, unknown>) => void;
  handleExit: (threadId: string, info: { code: number | null; stderr: string }) => void;
  handleError: (threadId: string, message: string) => void;

  // settings overlay
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  // search overlay
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /** Open a thread by session file, or focus it if already open. */
  goToThread: (cwd: string, file: string) => Promise<void>;

  // plugins overlay
  pluginsOpen: boolean;
  packages: PluginPackage[];
  skills: SkillInfo[];
  pluginsLoading: boolean;
  openPlugins: () => void;
  closePlugins: () => void;
  loadPlugins: () => Promise<void>;
  togglePackage: (source: string, enabled: boolean) => Promise<void>;
  installPackage: (source: string) => Promise<void>;
  removePackage: (source: string) => Promise<void>;
  updatePackages: (source?: string) => Promise<void>;
  toggleSkill: (path: string, enabled: boolean) => Promise<void>;

  // automation overlay
  automationOpen: boolean;
  tasks: AutomationTask[];
  openAutomation: () => void;
  closeAutomation: () => void;
  loadTasks: () => Promise<void>;
  saveTask: (task: AutomationTask) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  runTaskNow: (id: string) => Promise<void>;

  // thread permission / folder
  setPermission: (threadId: string, level: PermissionLevel) => Promise<void>;
  switchThreadFolder: (threadId: string) => Promise<void>;
  /** Move a not-yet-sent task to another working folder without losing the composer draft. */
  changeDraftThreadFolder: (threadId: string, cwd: string) => Promise<void>;

  // edit menu
  editAction: (action: "copy" | "cut" | "paste" | "delete" | "selectAll") => Promise<void>;
}

const treeKey = (cwd: string, rel?: string) => `${cwd}::${rel || ""}`;

/** In-flight background connects keyed by thread id, so a click and a
 *  same-tick prompt share one process boot instead of spawning two. */
const connectPromises = new Map<string, Promise<string | null>>();

/* ------------------------------------------------------------------ *
 * Event batching
 * ------------------------------------------------------------------ *
 * During streaming, pi emits many small events per second (one per text
 * delta). Applying each in its own React update keeps the main thread
 * saturated and makes unrelated UI (clicks, typing) lag. Coalesce: queue
 * incoming events and fold them into ONE store update per animation frame.
 * Render cost becomes per-frame instead of per-token, and a fast stream
 * never renders more than ~60 times a second no matter the event rate.
 */
const eventQueue: { threadId: string; event: any }[] = [];
let flushScheduled = false;

function scheduleEventFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const batch = eventQueue.splice(0, eventQueue.length);
    if (batch.length === 0) return;

    // Group per thread and remember which threads settled this frame.
    const byThread = new Map<string, any[]>();
    const settledIds: string[] = [];
    for (const { threadId, event } of batch) {
      let arr = byThread.get(threadId);
      if (!arr) {
        arr = [];
        byThread.set(threadId, arr);
      }
      arr.push(event);
      if (event?.type === "agent_settled") settledIds.push(threadId);
    }

    useStore.setState((s) => {
      let changed = false;
      const threads = { ...s.threads };
      for (const [threadId, events] of byThread) {
        const t0 = threads[threadId];
        if (!t0) continue;
        let t = t0;
        for (const ev of events) t = reduceThread(t, ev);
        if (t !== t0) {
          threads[threadId] = t;
          changed = true;
        }
      }
      return changed ? { threads } : s;
    });

    // Deliver queued follow-ups after the settled state is applied.
    for (const threadId of settledIds) {
      const st = useStore.getState();
      const p = st.threads[threadId]?.pendingFollowUp;
      if (p) {
        st.setPendingFollowUp(threadId, null);
        const { imgs, atts } = pendingToArgs(p);
        st.sendPrompt(threadId, p.text, imgs, atts);
      }
      // Message events do not include their persisted session entry ids.
      // Refresh once the turn settles so the Agent reply's Fork/Clone actions
      // are available without reopening the thread.
      window.pi.thread
        .getBranchMessages(threadId)
        .then((res: any) =>
          useStore.setState((s) =>
            s.threads[threadId]
              ? {
                  threads: {
                    ...s.threads,
                    [threadId]: {
                      ...s.threads[threadId],
                      messages: attachBranchEntryIds(s.threads[threadId].messages, res?.messages || []),
                    },
                  },
                }
              : s,
          ),
        )
        .catch(() => {});
      // The first session entry may only be visible on disk once the turn has
      // settled. Keep the project/thread index in lockstep with that lifecycle.
      const latest = useStore.getState();
      latest.refreshProjects();

      // Agent tools may have created or updated preview files. Refresh the
      // visible project's root tree, and reload an open preview so edits to the
      // HTML itself or any linked CSS/JS become visible without reopening it.
      const cwd = latest.threads[threadId]?.cwd;
      if (cwd && latest.fileTree[treeKey(cwd, "")]?.loaded) latest.loadFileTree(cwd, "");
      if (
        cwd &&
        latest.previewOpen &&
        latest.previewPath &&
        latest.previewRoot?.toLowerCase() === cwd.toLowerCase()
      ) {
        latest.openPreview(latest.previewPath, cwd);
      }
    }
  });
}

export const useStore = create<PiStore>()((set, get) => ({
  config: null,
  runtime: null,
  projects: [],
  projectsLoading: false,
  sidebarOpen: true,
  previewOpen: false,
  previewExpanded: false,
  sidebarTab: "threads",
  activeProjectCwd: null,
  expandedProjects: {},
  openThreadIds: [],
  activeThreadId: null,
  threads: {},
  fileTree: {},
  previewPath: null,
  previewRoot: null,
  previewPayload: null,
  previewLoading: false,
  toasts: [],
  extuiQueue: [],
  settingsOpen: false,

  bootstrap: async () => {
    // These calls are deliberately independent. Project discovery can be slow
    // and a failed config/project request must not leave runtime=null forever,
    // which the title bar previously rendered as a permanent "starting…".
    const runtimeTask = withTimeout(
      window.pi.app.resolveRuntime(),
      12_000,
      "Timed out while locating the Pi runtime",
    )
      .then((runtime) => {
        set({ runtime });
        if (!runtime.ok) get().pushToast("warning", runtime.error || "Could not locate Pi runtime");
      })
      .catch((e: any) => {
        const error = e?.message || String(e);
        set({ runtime: { ok: false, error } });
        get().pushToast("warning", error);
      });

    const [configResult, projectsResult] = await Promise.allSettled([
      window.pi.app.getConfig(),
      window.pi.app.getProjects(),
    ]);

    if (configResult.status === "fulfilled") {
      set({ config: configResult.value });
    } else {
      get().pushToast("error", "Failed to load settings: " + (configResult.reason?.message || configResult.reason));
    }

    if (projectsResult.status === "fulfilled") {
      const appConfig = configResult.status === "fulfilled" ? configResult.value : null;
      const projects = mergeLiveThreadsIntoProjects(
        projectsResult.value,
        {},
        appConfig?.archivedProjects || [],
        appConfig?.archivedThreads || [],
      );
      set((state) => ({
        projects,
        activeProjectCwd: state.activeProjectCwd || projects[0]?.cwd || null,
        expandedProjects:
          state.activeProjectCwd || !projects[0]
            ? state.expandedProjects
            : { ...state.expandedProjects, [projects[0].cwd]: true },
      }));
      if (projects[0]) {
        // Pre-warm the standby pi process for the active project so the first
        // "new task" adopts a booted process instead of cold-starting.
        window.pi.app.prewarm(projects[0].cwd).catch(() => {});
      }
    } else {
      get().pushToast("error", "Failed to load projects: " + (projectsResult.reason?.message || projectsResult.reason));
    }

    await runtimeTask;
  },

  refreshProjects: async () => {
    try {
      const diskProjects = await window.pi.app.getProjects();
      // Include prompts accepted by Pi even before its delayed JSONL flush.
      set((s) => ({
        projects: mergeLiveThreadsIntoProjects(
          diskProjects,
          s.threads,
          s.config?.archivedProjects || [],
          s.config?.archivedThreads || [],
        ),
      }));
    } catch (e: any) {
      get().pushToast("error", "Failed to load projects: " + (e?.message || e));
    }
  },

  openProjectFolder: async () => {
    try {
      const path = await window.pi.app.showOpenDialog("folder");
      if (!path) return;
      await window.pi.app.openProject(path);
      await get().refreshProjects();
      set({ activeProjectCwd: path, expandedProjects: { ...get().expandedProjects, [path]: true } });
    } catch (e: any) {
      get().pushToast("error", "Open folder failed: " + (e?.message || e));
    }
  },

  unpinProject: async (cwd) => {
    try {
      await window.pi.app.unpinProject(cwd);
      await get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", e?.message || "unpin failed");
    }
  },
  archiveProject: async (cwd) => {
    try {
      const current = get().config;
      if (!current) return;
      const archived = current.archivedProjects || [];
      if (!archived.some((path) => path.toLowerCase() === cwd.toLowerCase())) {
        const config = await window.pi.app.setConfig({ archivedProjects: [...archived, cwd] });
        set({ config });
      }
      // Close live views from this folder. Session files remain untouched and
      // reappear exactly as before when the project is restored.
      const ids = Object.entries(get().threads)
        .filter(([, thread]) => thread.cwd.toLowerCase() === cwd.toLowerCase())
        .map(([id]) => id);
      for (const id of ids) await get().closeThread(id);
      await get().refreshProjects();
      set((s) => ({
        activeProjectCwd:
          s.activeProjectCwd?.toLowerCase() === cwd.toLowerCase()
            ? s.projects[0]?.cwd || null
            : s.activeProjectCwd,
      }));
      get().pushToast("info", "项目已归档，可在设置的“归档项目”中恢复。");
    } catch (e: any) {
      get().pushToast("error", "归档项目失败：" + (e?.message || e));
    }
  },
  restoreProject: async (cwd) => {
    try {
      const current = get().config;
      if (!current) return;
      const config = await window.pi.app.setConfig({
        archivedProjects: (current.archivedProjects || []).filter(
          (path) => path.toLowerCase() !== cwd.toLowerCase(),
        ),
      });
      set({ config });
      await get().refreshProjects();
      get().pushToast("success", "项目已恢复到侧栏。");
    } catch (e: any) {
      get().pushToast("error", "恢复项目失败：" + (e?.message || e));
    }
  },
  archiveThread: async (cwd, file, title) => {
    try {
      const current = get().config;
      if (!current || !file || file.startsWith("opening-") || file.startsWith("boot:")) return;
      const archived = current.archivedThreads || [];
      const alreadyArchived = archived.some((thread) => thread.file.toLowerCase() === file.toLowerCase());
      if (!alreadyArchived) {
        const config = await window.pi.app.setConfig({
          archivedThreads: [
            ...archived,
            {
              file,
              cwd,
              title: title?.trim() || file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || file,
            },
          ],
        });
        set({ config });
      }

      // Close an open view without touching its JSONL session file. The
      // session remains available and can be restored from Settings.
      const ids = Object.entries(get().threads)
        .filter(([id, thread]) => (thread.sessionFile || id).toLowerCase() === file.toLowerCase())
        .map(([id]) => id);
      for (const id of ids) await get().closeThread(id);
      await get().refreshProjects();
      get().pushToast("info", "线程已归档，可在设置的“归档线程”中恢复。");
    } catch (e: any) {
      get().pushToast("error", "归档线程失败：" + (e?.message || e));
    }
  },
  restoreThread: async (file) => {
    try {
      const current = get().config;
      if (!current || !file) return;
      const archived = current.archivedThreads || [];
      const next = archived.filter((thread) => thread.file.toLowerCase() !== file.toLowerCase());
      if (next.length === archived.length) return;
      const config = await window.pi.app.setConfig({ archivedThreads: next });
      set({ config });
      await get().refreshProjects();
      get().pushToast("success", "线程已恢复到侧栏。");
    } catch (e: any) {
      get().pushToast("error", "恢复线程失败：" + (e?.message || e));
    }
  },

  toggleProject: (cwd) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [cwd]: !s.expandedProjects[cwd] } })),
  setActiveProject: (cwd) => set({ activeProjectCwd: cwd }),

  openThread: async (cwd, sessionFile, permission) => {
    // Already on screen: just activate. If it was only disk-rendered so far
    // (no live process yet), kick off / reuse the background connect so it
    // becomes interactive.
    if (sessionFile && get().threads[sessionFile]) {
      set((s) => ({
        activeThreadId: sessionFile,
        activeProjectCwd: cwd,
        expandedProjects: { ...s.expandedProjects, [cwd]: true },
      }));
      if (!get().threads[sessionFile].connected) get().ensureConnected(sessionFile);
      return sessionFile;
    }

    if (sessionFile) {
      // RESUMING an existing session. Its full transcript lives in the .jsonl
      // on disk, so render it instantly (milliseconds) and connect the pi
      // process in the background — no blocking "starting pi" spinner.
      try {
        const hist: any = await window.pi.thread.loadHistory({ cwd, sessionFile });
        const { views, toolRuns } = historyToView(hist.messages || [], hist.branchMessages || []);
        const thread: ThreadState = {
          ...emptyThread(hist.cwd || cwd),
          sessionFile: hist.sessionFile || sessionFile,
          sessionName: hist.sessionName,
          model: hist.model,
          models: hist.models || [],
          thinking: hist.thinkingLevel || "off",
          commands: hist.commands || [],
          loading: false,
          connected: !!hist.connected,
          isStreaming: !!hist.isStreaming,
          messages: views,
          toolRuns,
          permission: hist.permission || permission || "sandbox",
        };
        set((s) => ({
          threads: { ...s.threads, [sessionFile]: thread },
          openThreadIds: s.openThreadIds.includes(sessionFile) ? s.openThreadIds : [...s.openThreadIds, sessionFile],
          activeThreadId: sessionFile,
          activeProjectCwd: hist.cwd || cwd,
          expandedProjects: { ...s.expandedProjects, [hist.cwd || cwd]: true },
        }));
        if (hist.connected) {
          window.pi.thread
            .getThinkingLevels(sessionFile)
            .then((r: any) => set((s) => (s.threads[sessionFile] ? { threads: { ...s.threads, [sessionFile]: { ...s.threads[sessionFile], levels: r?.levels || ["off"] } } } : s)))
            .catch(() => {});
        } else {
          get().ensureConnected(sessionFile);
        }
        return sessionFile;
      } catch (e: any) {
        get().pushToast("error", "Open thread failed: " + (e?.message || e));
        return null;
      }
    }

    // NEW TASK (no session file): nothing on disk to show, but the empty chat
    // + composer appear instantly and the pi process connects in the
    // background (adopting the warm spare). No blocking "starting pi" spinner.
    // The temp id is remapped to the real session file once connected.
    const tempId = `opening-${uid()}`;
    const placeholder: ThreadState = { ...emptyThread(cwd), loading: false, connected: false, permission: permission || "sandbox" };
    set((s) => ({
      threads: { ...s.threads, [tempId]: placeholder },
      openThreadIds: s.openThreadIds.includes(tempId) ? s.openThreadIds : [...s.openThreadIds, tempId],
      activeThreadId: tempId,
      activeProjectCwd: cwd,
      expandedProjects: { ...s.expandedProjects, [cwd]: true },
    }));
    get().ensureConnected(tempId);
    return tempId;
  },

  ensureConnected: (threadId) => {
    const t = get().threads[threadId];
    if (!t) return Promise.resolve(null);
    if (t.connected) return Promise.resolve(threadId);
    const inflight = connectPromises.get(threadId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        // For a resumed session thread:open returns the same session file as
        // the id, so the thread keeps its key; the remap guard is defensive.
        const res: any = await window.pi.thread.open({ cwd: t.cwd, sessionFile: t.sessionFile || undefined, permission: t.permission });
        const id = res.threadId || threadId;
        const { views, toolRuns } = historyToView(res.messages || [], res.branchMessages || []);
        set((s) => {
          const prev = s.threads[threadId] || s.threads[id];
          // Preserve optimistic user bubbles added before the connect finished
          // (e.g. a fast first send on a brand-new thread); live history never
          // contains them, so without this they would be dropped on merge/remap.
          const optimistic = (prev?.messages || []).filter((m) => m.key.startsWith("opt-"));
          const merged: ThreadState = {
            ...emptyThread(res.cwd || t.cwd),
            sessionFile: res.sessionFile || t.sessionFile,
            sessionName: res.sessionName ?? prev?.sessionName ?? null,
            model: res.model ?? prev?.model ?? null,
            models: res.models || [],
            thinking: res.thinkingLevel || prev?.thinking || "off",
            commands: res.commands || [],
            loading: false,
            connected: true,
            isStreaming: !!res.isStreaming || optimistic.length > 0,
            messages: optimistic.length ? [...views, ...optimistic] : views,
            toolRuns,
            permission: res.permission || t.permission,
            pendingEditorText: prev?.pendingEditorText,
          };
          const threads: Record<string, ThreadState> = { ...s.threads, [id]: merged };
          let openThreadIds = s.openThreadIds;
          let activeThreadId = s.activeThreadId;
          if (id !== threadId) {
            delete threads[threadId];
            openThreadIds = openThreadIds.map((x) => (x === threadId ? id : x));
            if (activeThreadId === threadId) activeThreadId = id;
          }
          return { threads, openThreadIds, activeThreadId };
        });
        // A brand-new session just appeared on disk (temp id remapped to the
        // real session file); refresh the sidebar so it shows under its project.
        if (id !== threadId) get().refreshProjects();
        window.pi.thread
          .getThinkingLevels(id)
          .then((r: any) => set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: { ...s.threads[id], levels: r?.levels || ["off"] } } } : s)))
          .catch(() => {});
        return id;
      } catch (e: any) {
        // Keep the disk-rendered transcript visible; only mark the failure.
        set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], connected: false, error: e?.message || "connect failed" } } } : s));
        get().pushToast("error", "连接 pi 进程失败：" + (e?.message || e));
        return null;
      } finally {
        connectPromises.delete(threadId);
      }
    })();
    connectPromises.set(threadId, p);
    return p;
  },

  closeThread: async (id) => {
    try {
      await window.pi.thread.close(id);
    } catch {
      /* ignore */
    }
    set((s) => {
      const openThreadIds = s.openThreadIds.filter((x) => x !== id);
      const threads = { ...s.threads };
      delete threads[id];
      let activeThreadId = s.activeThreadId;
      if (activeThreadId === id) activeThreadId = openThreadIds[openThreadIds.length - 1] || null;
      const activeProjectCwd = activeThreadId ? threads[activeThreadId]?.cwd || null : null;
      return { openThreadIds, threads, activeThreadId, activeProjectCwd };
    });
  },

  setActiveThread: (id) =>
    set((s) => {
      const cwd = s.threads[id]?.cwd;
      return cwd
        ? { activeThreadId: id, activeProjectCwd: cwd, expandedProjects: { ...s.expandedProjects, [cwd]: true } }
        : { activeThreadId: id };
    }),

  newTask: async () => {
    let cwd: string | null = get().activeProjectCwd;
    if (!cwd) {
      const p = await window.pi.app.showOpenDialog("folder");
      if (!p || Array.isArray(p)) return;
      await window.pi.app.openProject(p);
      await get().refreshProjects();
      set({ activeProjectCwd: p, expandedProjects: { ...get().expandedProjects, [p]: true } });
      cwd = p;
    }
    if (cwd) {
      // Flush any just-persisted current session into the sidebar before
      // switching to a fresh empty task.
      await get().refreshProjects();
      await get().openThread(cwd);
    }
  },

  sendPrompt: async (threadId, text, images, attachments, mode) => {
    const trimmed = (text || "").trim();
    const hasImg = !!images && images.length > 0;
    const hasAtt = !!attachments && attachments.length > 0;
    if (!trimmed && !hasImg && !hasAtt) return;
    const wasStreaming = !!get().threads[threadId]?.isStreaming;
    const optimistic: ViewMessage = {
      key: `opt-${uid()}`,
      role: "user",
      text: trimmed,
      images: (images || []).map((im) => ({ dataUrl: `data:${im.mimeType};base64,${im.data}`, mimeType: im.mimeType })),
      timestamp: Date.now(),
      sendKind: wasStreaming ? (mode === "followUp" ? "followUp" : "steer") : undefined,
    };
    // Show the user's bubble immediately, even if the process is still
    // connecting in the background — the chat must never look frozen.
    set((s) => {
      const t = s.threads[threadId];
      if (!t) return s;
      return { threads: { ...s.threads, [threadId]: { ...t, messages: [...t.messages, optimistic], isStreaming: true, error: undefined } } };
    });
    // A disk-rendered or brand-new thread may not have a live process yet.
    // ensureConnected keeps the optimistic bubble across the connect/remap and
    // resolves with the thread's final id (a new task starts under a temp id).
    const tid = await get().ensureConnected(threadId);
    if (!tid) {
      // Connection failed: roll back the bubble. The thread is still under its
      // original id (remap only happens on success).
      set((s) => {
        const t = s.threads[threadId];
        if (!t) return s;
        return { threads: { ...s.threads, [threadId]: { ...t, isStreaming: false, messages: t.messages.filter((m) => m.key !== optimistic.key) } } };
      });
      return;
    }
    const piImages = (images || []).map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }));
    try {
      if (wasStreaming) {
        // mode: "steer" interrupts current work; "followUp" waits until agent finishes
        if (mode === "followUp") {
          await window.pi.thread.followUp({ threadId: tid, text: trimmed, images: piImages, attachments });
        } else {
          await window.pi.thread.steer({ threadId: tid, text: trimmed, images: piImages, attachments });
        }
      } else {
        await window.pi.thread.prompt({ threadId: tid, text: trimmed, images: piImages, attachments });
      }
      // Pi creates/persists a new session lazily on its first prompt.
      await get().refreshProjects();
    } catch (e: any) {
      set((s) => {
        const t = s.threads[tid];
        if (!t) return s;
        return { threads: { ...s.threads, [tid]: { ...t, isStreaming: false, error: e?.message || "prompt failed" } } };
      });
      get().pushToast("error", e?.message || "prompt failed");
    }
  },

  setPendingFollowUp: (threadId, pending) => {
    set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], pendingFollowUp: pending } } } : s));
  },

  sendPendingSteering: async (threadId) => {
    const p = get().threads[threadId]?.pendingFollowUp;
    if (!p) return;
    get().setPendingFollowUp(threadId, null);
    const { imgs, atts } = pendingToArgs(p);
    await get().sendPrompt(threadId, p.text, imgs, atts, "steer");
  },

  abortThread: async (id) => {
    try {
      await window.pi.thread.abort(id);
    } catch (e: any) {
      get().pushToast("error", e?.message || "abort failed");
    }
  },

  refreshOpenThreadModels: async () => {
    const connected = Object.entries(get().threads).filter(([, thread]) => thread.connected);
    const results = await Promise.allSettled(
      connected.map(async ([id]) => ({ id, response: await window.pi.thread.refreshModels(id) })),
    );
    set((state) => {
      const threads = { ...state.threads };
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { id, response } = result.value as { id: string; response: { models?: ModelInfo[] } };
        const thread = threads[id];
        if (thread) threads[id] = { ...thread, models: response?.models || [] };
      }
      return { threads };
    });
  },

  setModel: async (id, provider, modelId) => {
    if (!(await get().ensureConnected(id))) return;
    try {
      const res: any = await window.pi.thread.setModel({ threadId: id, provider, modelId });
      const nextModel = res?.model || res || { provider, id: modelId };
      set((s) =>
        s.threads[id]
          ? {
              threads: {
                ...s.threads,
                [id]: {
                  ...s.threads[id],
                  model: nextModel,
                  ...(typeof res?.thinkingLevel === "string" ? { thinking: res.thinkingLevel } : {}),
                },
              },
            }
          : s,
      );
      window.pi.thread
        .getThinkingLevels(id)
        .then((r: any) => set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: { ...s.threads[id], levels: r?.levels || ["off"] } } } : s)))
        .catch(() => {});
    } catch (e: any) {
      get().pushToast("error", e?.message || "set model failed");
    }
  },

  setThinking: async (id, level) => {
    if (!(await get().ensureConnected(id))) return;
    try {
      const res: any = await window.pi.thread.setThinking({ threadId: id, level });
      const effectiveLevel = typeof res?.thinkingLevel === "string" ? res.thinkingLevel : level;
      set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: { ...s.threads[id], thinking: effectiveLevel } } } : s));
    } catch (e: any) {
      get().pushToast("error", e?.message || "set thinking failed");
    }
  },

  newSessionInThread: async (id) => {
    if (!(await get().ensureConnected(id))) return;
    try {
      const res: any = await window.pi.thread.newSession(id);
      if (res?.cancelled) return;
      const newId = res.threadId || id;
      const { views, toolRuns } = historyToView(res.messages || [], res.branchMessages || []);
      const thread: ThreadState = {
        ...emptyThread(res.cwd || get().threads[id]?.cwd || ""),
        sessionFile: res.sessionFile,
        sessionName: res.sessionName,
        model: res.model,
        models: res.models || get().threads[id]?.models || [],
        thinking: res.thinkingLevel || "off",
        commands: res.commands || [],
        messages: views,
        toolRuns,
        permission: res.permission || get().threads[id]?.permission || "sandbox",
      };
      set((s) => {
        const threads: Record<string, ThreadState> = { ...s.threads, [newId]: thread };
        if (newId !== id) delete threads[id];
        const openThreadIds = s.openThreadIds.map((x) => (x === id ? newId : x));
        return { threads, openThreadIds, activeThreadId: newId };
      });
      if (newId !== id) get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", e?.message || "new session failed");
    }
  },

  forkThreadFromAgentReply: async (id, entryId) => {
    const liveId = await get().ensureConnected(id);
    if (!liveId) return;
    const source = get().threads[liveId];
    if (!source || source.isStreaming) {
      get().pushToast("warning", "请等待当前回复结束后再 Fork。");
      return;
    }
    try {
      const res: any = await window.pi.thread.fork({ threadId: liveId, entryId });
      if (res?.cancelled) return;
      const newId = res.threadId || liveId;
      const next = threadFromResponse(res, source, res.selectedText || undefined);
      set((s) => {
        const threads: Record<string, ThreadState> = { ...s.threads };
        if (newId !== liveId) {
          threads[liveId] = { ...source, connected: false, isStreaming: false, streaming: null };
        }
        threads[newId] = next;
        const openThreadIds =
          newId === liveId || s.openThreadIds.includes(newId) ? s.openThreadIds : [...s.openThreadIds, newId];
        return { threads, openThreadIds, activeThreadId: newId, activeProjectCwd: next.cwd };
      });
      get().pushToast("info", "已从所选 Agent 回复创建 Fork。");
      get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", e?.message || "fork failed");
    }
  },

  cloneThread: async (id, entryId) => {
    const liveId = await get().ensureConnected(id);
    if (!liveId) return;
    const source = get().threads[liveId];
    if (!source || source.isStreaming) {
      get().pushToast("warning", "请等待当前回复结束后再 Clone。");
      return;
    }
    try {
      const res: any = await window.pi.thread.clone({ threadId: liveId, entryId });
      if (res?.cancelled) return;
      const newId = res.threadId || liveId;
      const next = threadFromResponse(res, source);
      set((s) => {
        const threads: Record<string, ThreadState> = { ...s.threads };
        if (newId !== liveId) {
          threads[liveId] = { ...source, connected: false, isStreaming: false, streaming: null };
        }
        threads[newId] = next;
        const openThreadIds =
          newId === liveId || s.openThreadIds.includes(newId) ? s.openThreadIds : [...s.openThreadIds, newId];
        return { threads, openThreadIds, activeThreadId: newId, activeProjectCwd: next.cwd };
      });
      get().pushToast("info", "已 Clone 截至所选 Agent 回复的分支。");
      get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", e?.message || "clone failed");
    }
  },

  renameThread: async (id, name) => {
    if (!(await get().ensureConnected(id))) return;
    try {
      await window.pi.thread.setName({ threadId: id, name });
      set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: { ...s.threads[id], sessionName: name } } } : s));
      get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", e?.message || "rename failed");
    }
  },

  setSidebarTab: (t) => set({ sidebarTab: t }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  togglePreview: () =>
    set((s) => ({
      previewOpen: !s.previewOpen,
      previewExpanded: s.previewOpen ? false : s.previewExpanded,
    })),
  togglePreviewExpanded: () =>
    set((s) => ({
      previewExpanded: s.previewOpen ? !s.previewExpanded : false,
    })),

  loadFileTree: async (cwd, rel) => {
    const key = treeKey(cwd, rel);
    try {
      const nodes = await window.pi.app.getFileTree(cwd, rel);
      set((s) => ({ fileTree: { ...s.fileTree, [key]: { nodes, loaded: true, expanded: s.fileTree[key]?.expanded ?? true } } }));
    } catch (e: any) {
      get().pushToast("error", e?.message || "load tree failed");
    }
  },

  toggleFolder: (cwd, rel) => {
    const key = treeKey(cwd, rel);
    const cur = get().fileTree[key];
    if (cur?.expanded) {
      set((s) => ({ fileTree: { ...s.fileTree, [key]: { ...cur, expanded: false } } }));
      return;
    }
    if (cur?.loaded) {
      set((s) => ({ fileTree: { ...s.fileTree, [key]: { ...cur, expanded: true } } }));
      return;
    }
    set((s) => ({ fileTree: { ...s.fileTree, [key]: { nodes: [], loaded: false, expanded: true } } }));
    get().loadFileTree(cwd, rel);
  },

  openPreview: async (abs, projectRoot) => {
    const root = projectRoot || get().previewRoot || undefined;
    set({ previewOpen: true, previewPath: abs, previewRoot: root || null, previewLoading: true, previewPayload: null });
    try {
      const payload = await window.pi.app.readPreview(abs, root);
      set({ previewPayload: payload, previewLoading: false });
    } catch (e: any) {
      set({ previewLoading: false, previewPayload: { name: abs.split(/[\\/]/).pop() || abs, ext: "", size: 0, kind: "missing", message: e?.message || "read failed" } });
    }
  },

  closePreview: () =>
    set({
      previewOpen: false,
      previewExpanded: false,
      previewPath: null,
      previewRoot: null,
      previewPayload: null,
    }),

  pushToast: (kind, text) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), 5200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  handleEvent: (threadId, event) => {
    // Queued and folded into one store update per frame (see scheduleEventFlush).
    eventQueue.push({ threadId, event });
    scheduleEventFlush();
  },

  handleExtUi: (threadId, req) => {
    const m = req?.method;
    if (m === "notify") {
      get().pushToast(req.notifyType === "error" ? "error" : req.notifyType === "warning" ? "warning" : "info", (req.message || req.title || "") as string);
      return;
    }
    if (m === "set_editor_text") {
      set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], pendingEditorText: req.text as string } } } : s));
      return;
    }
    if (m === "setTitle") {
      if (req.title) document.title = String(req.title);
      return;
    }
    if (m === "setStatus" || m === "setWidget") return; // not surfaced yet
    // dialog methods -> queue
    if (m === "select" || m === "confirm" || m === "input" || m === "editor") {
      set((s) => ({
        extuiQueue: [...s.extuiQueue, { threadId, request: req }],
        // Confirmation cards belong above the relevant thread's composer.
        activeThreadId: (m === "select" || m === "confirm") && s.threads[threadId] ? threadId : s.activeThreadId,
      }));
      return;
    }
  },

  respondExtUi: (threadId, id, payload) => {
    window.pi.thread.extuiResponse({ threadId, id, payload }).catch(() => {});
    set((s) => ({ extuiQueue: s.extuiQueue.filter((q) => q.request.id !== id) }));
  },

  handleExit: (threadId, info) => {
    // The thread may already be gone (intentional close / permission switch);
    // its exit is then expected and must not raise an error toast.
    if (!get().threads[threadId]) return;
    set((s) => {
      const t = s.threads[threadId];
      if (!t) return s;
      return { threads: { ...s.threads, [threadId]: { ...t, isStreaming: false, streaming: null, error: `pi exited (code ${info.code})` } } };
    });
    const tail = (info.stderr || "").trim().split(/\r?\n/).slice(-3).join(" | ");
    get().pushToast("error", `pi process exited (${info.code})${tail ? ": " + tail : ""}`);
  },

  handleError: (threadId, message) => {
    set((s) => {
      const t = s.threads[threadId];
      if (!t) return s;
      return { threads: { ...s.threads, [threadId]: { ...t, error: message } } };
    });
    get().pushToast("error", message);
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  goToThread: async (cwd, file) => {
    const s = get();
    if (s.openThreadIds.includes(file)) {
      set({ activeThreadId: file, activeProjectCwd: cwd, expandedProjects: { ...s.expandedProjects, [cwd]: true } });
      return;
    }
    await s.openThread(cwd, file);
  },

  // ---- plugins ----
  pluginsOpen: false,
  packages: [],
  skills: [],
  pluginsLoading: false,
  openPlugins: () => {
    set({ pluginsOpen: true });
    get().loadPlugins();
  },
  closePlugins: () => set({ pluginsOpen: false }),
  loadPlugins: async () => {
    set({ pluginsLoading: true });
    try {
      const activeProjectCwd = get().activeProjectCwd || undefined;
      const [packages, skills] = await Promise.all([window.pi.plugins.getPackages(), window.pi.plugins.getSkills(activeProjectCwd)]);
      set({ packages, skills, pluginsLoading: false });
    } catch (e: any) {
      set({ pluginsLoading: false });
      get().pushToast("error", "加载插件失败：" + (e?.message || e));
    }
  },
  togglePackage: async (source, enabled) => {
    set((s) => ({ packages: s.packages.map((p) => (p.source === source ? { ...p, enabled } : p)) }));
    try {
      await window.pi.plugins.setPackageEnabled(source, enabled);
    } catch (e: any) {
      get().pushToast("error", e?.message || "切换失败");
      get().loadPlugins();
    }
  },
  installPackage: async (source) => {
    try {
      const res: any = await window.pi.plugins.installPackage(source);
      if (res?.output) get().pushToast(res.ok ? "info" : "warning", String(res.output).slice(0, 300));
      await get().loadPlugins();
    } catch (e: any) {
      get().pushToast("error", "安装失败：" + (e?.message || e));
    }
  },
  removePackage: async (source) => {
    try {
      await window.pi.plugins.removePackage(source);
      await get().loadPlugins();
    } catch (e: any) {
      get().pushToast("error", "移除失败：" + (e?.message || e));
    }
  },
  updatePackages: async (source) => {
    const label = source ? "更新扩展" : "更新全部扩展";
    try {
      const res: any = await window.pi.plugins.updatePackages(source);
      const raw = stripAnsi(res?.output || "");
      const text = cleanOutput(raw);
      const assertion = hasLibuvAssertion(raw);

      if (res?.ok) {
        if (extensionsAlreadyLatest(text)) {
          get().pushToast("info", source ? "该扩展已是最新版本。" : "所有扩展已是最新版本。");
        } else {
          get().pushToast("success", source ? "扩展已更新到最新版本。" : "所有扩展已更新到最新版本。");
        }
      } else if (assertion) {
        // The libuv assertion fires during process teardown on Windows — the
        // actual update (npm) likely completed before the crash.
        if (/Updated/i.test(text)) {
          get().pushToast("success", source ? "扩展已更新。" : "扩展已更新。");
        } else if (extensionsAlreadyLatest(text)) {
          get().pushToast("info", source ? "该扩展已是最新版本。" : "所有扩展已是最新版本。");
        } else {
          get().pushToast("warning", "更新命令已执行，但进程退出异常。请检查扩展版本。");
        }
      } else {
        get().pushToast("error", `${label}失败：` + (lastLine(text) || "未知错误"));
      }
      await get().loadPlugins();
    } catch (e: any) {
      get().pushToast("error", `${label}失败：` + (e?.message || e));
    }
  },
  toggleSkill: async (path, enabled) => {
    set((s) => ({ skills: s.skills.map((sk) => (sk.path === path ? { ...sk, enabled } : sk)) }));
    try {
      await window.pi.plugins.setSkillEnabled(path, enabled);
    } catch (e: any) {
      get().pushToast("error", e?.message || "切换失败");
      get().loadPlugins();
    }
  },

  // ---- automation ----
  automationOpen: false,
  tasks: [],
  openAutomation: () => {
    set({ automationOpen: true });
    get().loadTasks();
  },
  closeAutomation: () => set({ automationOpen: false }),
  loadTasks: async () => {
    try {
      const tasks = await window.pi.automation.getTasks();
      set({ tasks });
    } catch (e: any) {
      get().pushToast("error", "加载任务失败：" + (e?.message || e));
    }
  },
  saveTask: async (task) => {
    try {
      await window.pi.automation.saveTask(task);
      await get().loadTasks();
    } catch (e: any) {
      get().pushToast("error", "保存任务失败：" + (e?.message || e));
    }
  },
  deleteTask: async (id) => {
    try {
      await window.pi.automation.deleteTask(id);
      await get().loadTasks();
    } catch (e: any) {
      get().pushToast("error", e?.message || "删除失败");
    }
  },
  runTaskNow: async (id) => {
    try {
      get().pushToast("info", "任务已开始执行…");
      await window.pi.automation.runNow(id);
      await get().loadTasks();
      await get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", "执行失败：" + (e?.message || e));
    }
  },

  // ---- thread permission / folder ----
  setPermission: async (threadId, level) => {
    const t = get().threads[threadId];
    if (!t || t.permission === level) return;
    set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], permission: level } } } : s));
    try {
      // The gate extension is always loaded; switching just flips its live mode
      // file, so the pi process and session keep running uninterrupted.
      await window.pi.thread.setPermission({ threadId, permission: level });
      get().pushToast("info", level === "sandbox" ? "已切换到 sandbox（非只读命令及项目外写入需确认）。" : "已切换到完全权限。");
    } catch (e: any) {
      get().pushToast("error", "切换权限失败：" + (e?.message || e));
    }
  },
  switchThreadFolder: async (threadId) => {
    try {
      const path = await window.pi.app.showOpenDialog("folder");
      if (!path || Array.isArray(path)) return;
      await window.pi.app.openProject(path);
      await get().refreshProjects();
      await get().openThread(path, undefined, get().threads[threadId]?.permission);
    } catch (e: any) {
      get().pushToast("error", "切换文件夹失败：" + (e?.message || e));
    }
  },
  changeDraftThreadFolder: async (threadId, cwd) => {
    const original = get().threads[threadId];
    if (!original || original.cwd === cwd) return;
    if (original.messages.some((message) => message.role === "user" || message.role === "assistant")) {
      get().pushToast("warning", "只能在发送第一条消息前更换任务文件夹。");
      return;
    }
    try {
      // Resolve the old optimistic id first so its process can be closed
      // reliably. Open the replacement before closing it: activeThreadId never
      // becomes null, so React preserves the Composer's unsent local draft.
      const oldId = (await get().ensureConnected(threadId)) || threadId;
      await window.pi.app.openProject(cwd);
      await get().refreshProjects();
      const newId = await get().openThread(cwd, undefined, original.permission);
      if (!newId) return;
      await get().closeThread(oldId);
    } catch (e: any) {
      get().pushToast("error", "切换文件夹失败：" + (e?.message || e));
    }
  },

  // ---- edit menu ----
  editAction: async (action) => {
    try {
      await window.pi.app.editAction(action);
    } catch {
      /* ignore */
    }
  },
}));
