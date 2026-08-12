import { create } from "zustand";
import type {
  AppConfig,
  AppRuntime,
  AppUpdateStatus,
  ArchivedThread,
  AutomationTask,
  ContentBlock,
  CoreUpdateStatus,
  ExtUiRequest,
  FileNode,
  GitFileStatus,
  McpServerConfig,
  McpState,
  ModelInfo,
  OmpConfigSection,
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
import { applyAsyncJobs } from "./lib/subagents";
import { panesForActivate, panesForClose } from "./lib/panes";

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */


const OPEN_TABS_KEY = "pi-studio.open-tabs";
let openTabsHydrated = false;

type PersistedOpenTabs = {
  openThreadIds: string[];
  activeThreadId: string | null;
  pinnedThreadIds?: string[];
  /** Split view: thread shown in the LEFT pane (absent on old payloads). */
  primaryThreadId?: string | null;
  /** Split view: thread shown in the RIGHT pane; null/absent = single pane. */
  paneThreadId?: string | null;
};

function isPersistableThreadId(id: string): boolean {
  return !!id && !id.startsWith("opening-");
}

/** Keep pinned tabs on the left; preserve relative order within each group. */
function normalizeOpenTabOrder(openThreadIds: string[], pinnedThreadIds: string[]): {
  openThreadIds: string[];
  pinnedThreadIds: string[];
} {
  const openSet = new Set(openThreadIds);
  const pinnedListed = pinnedThreadIds.filter((id) => openSet.has(id) && isPersistableThreadId(id));
  const pinnedSet = new Set(pinnedListed);
  const unpinned = openThreadIds.filter((id) => !pinnedSet.has(id));
  const seen = new Set<string>();
  const pinnedUnique = pinnedListed.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return { openThreadIds: [...pinnedUnique, ...unpinned], pinnedThreadIds: pinnedUnique };
}

function loadPersistedOpenTabs(): PersistedOpenTabs | null {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedOpenTabs;
    if (!parsed || !Array.isArray(parsed.openThreadIds)) return null;
    const openThreadIds = parsed.openThreadIds.filter((id) => typeof id === "string" && isPersistableThreadId(id));
    const activeThreadId =
      typeof parsed.activeThreadId === "string" && openThreadIds.includes(parsed.activeThreadId)
        ? parsed.activeThreadId
        : openThreadIds[openThreadIds.length - 1] || null;
    const pinnedRaw = Array.isArray(parsed.pinnedThreadIds) ? parsed.pinnedThreadIds : [];
    const pinnedThreadIds = pinnedRaw.filter((id) => typeof id === "string" && openThreadIds.includes(id));
    const normalized = normalizeOpenTabOrder(openThreadIds, pinnedThreadIds);
    const primaryThreadId =
      typeof parsed.primaryThreadId === "string" && normalized.openThreadIds.includes(parsed.primaryThreadId)
        ? parsed.primaryThreadId
        : activeThreadId;
    const paneThreadId =
      typeof parsed.paneThreadId === "string" &&
      normalized.openThreadIds.includes(parsed.paneThreadId) &&
      parsed.paneThreadId !== primaryThreadId
        ? parsed.paneThreadId
        : null;
    return {
      openThreadIds: normalized.openThreadIds,
      activeThreadId:
        activeThreadId && (activeThreadId === primaryThreadId || activeThreadId === paneThreadId)
          ? activeThreadId
          : primaryThreadId,
      pinnedThreadIds: normalized.pinnedThreadIds,
      primaryThreadId,
      paneThreadId,
    };
  } catch {
    return null;
  }
}

function persistOpenTabs(
  openThreadIds: string[],
  activeThreadId: string | null,
  pinnedThreadIds: string[] = [],
  primaryThreadId: string | null = null,
  paneThreadId: string | null = null,
): void {
  const ids = openThreadIds.filter(isPersistableThreadId);
  // Before bootstrap finishes, avoid wiping a previously saved non-empty set with [].
  if (!openTabsHydrated && ids.length === 0) return;
  const normalized = normalizeOpenTabOrder(ids, pinnedThreadIds);
  const active =
    activeThreadId && normalized.openThreadIds.includes(activeThreadId)
      ? activeThreadId
      : normalized.openThreadIds[normalized.openThreadIds.length - 1] || null;
  const primary =
    primaryThreadId && normalized.openThreadIds.includes(primaryThreadId) ? primaryThreadId : active;
  const pane =
    paneThreadId && normalized.openThreadIds.includes(paneThreadId) && paneThreadId !== primary
      ? paneThreadId
      : null;
  try {
    const payload: PersistedOpenTabs = {
      openThreadIds: normalized.openThreadIds,
      activeThreadId: active,
      pinnedThreadIds: normalized.pinnedThreadIds,
      primaryThreadId: primary,
      paneThreadId: pane,
    };
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

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
      title: getDisplayThreadTitle(thread.sessionName, firstText).slice(0, 80) || "新会话",
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

/** Parse an omp advisor `custom_message` body ("<advisory severity=… guidance=…>…</advisory>"). */
function parseAdvisory(content: string): { severity?: string; guidance?: string; text: string } | null {
  if (!content) return null;
  const m = content.match(/^\s*<advisory\b([^>]*)>([\s\S]*?)<\/advisory>\s*$/);
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  if (!m) return { text: decode(content.trim()) };
  const attrs = m[1] || "";
  const severity = attrs.match(/severity="([^"]+)"/)?.[1];
  const guidance = attrs.match(/guidance="([^"]+)"/)?.[1];
  const text = decode(m[2]).trim();
  return text ? { severity, guidance, text } : null;
}

/** Convert a flat list of pi AgentMessages into renderable views + initial tool runs. */
function historyToView(messages: any[]): { views: ViewMessage[]; toolRuns: Record<string, ToolRun> } {
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
        usage: m.usage,
      });
    } else if ((m.type === "custom_message" || m.role === "custom") && m.customType === "advisor") {
      const adv = parseAdvisory(typeof m.content === "string" ? m.content : "");
      if (adv) {
        views.push({ key: `hs-${i}`, role: "system", text: adv.text, severity: adv.severity, guidance: adv.guidance, timestamp: m.timestamp, kind: "advisor" });
      }
    }
  });
  return { views, toolRuns };
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
    permission: "auto",
    advisory: false,
    planMode: false,
  };
}

function threadFromResponse(res: any, fallback: ThreadState, pendingEditorText?: string): ThreadState {
  const { views, toolRuns } = historyToView(res.messages || []);
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
    permission: res.permission || fallback.permission || "auto",
    advisory: res.advisory ?? false,
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
      if (m.role === "custom") {
        // async-result: a background subagent spawned by a `task` batch finished.
        if (m.customType === "async-result") {
          const toolRuns = applyAsyncJobs(t.toolRuns, m?.details?.jobs);
          return toolRuns ? { ...t, toolRuns } : t;
        }
        // advisor notes arrive live as message_start/message_end with role "custom"
        // (same shape `get_messages` returns); the top-level `custom_message`
        // frame only exists in the session file, so the live path must handle it here.
        if (m.customType === "advisor") {
          const adv = parseAdvisory(typeof m.content === "string" ? m.content : "");
          if (adv) {
            const view: ViewMessage = { key: `sys-${uid()}`, role: "system", text: adv.text, severity: adv.severity, guidance: adv.guidance, timestamp: m.timestamp, kind: "advisor" };
            return { ...t, messages: [...t.messages, view] };
          }
        }
        return t;
      }
      if (m.role === "assistant") {
        // message_start may already carry usage when the frame replays a
        // completed turn (reconnect mid-stream); the live path fills it at end.
        return { ...t, streaming: { ...newAssistant(), usage: m.usage } };
      }
      return t;
    }
    case "custom_message": {
      if (event.customType !== "advisor" && event.customType !== "recap") return t;
      const adv = parseAdvisory(typeof event.content === "string" ? event.content : "");
      if (!adv) return t;
      const view: ViewMessage = { key: `sys-${uid()}`, role: "system", text: adv.text, severity: adv.severity, guidance: adv.guidance, timestamp: event.timestamp, kind: event.customType };
      return { ...t, messages: [...t.messages, view] };
    }
    case "message_end": {
      const m = event.message;
      if (m?.role === "custom" && m.customType === "async-result") {
        const toolRuns = applyAsyncJobs(t.toolRuns, m?.details?.jobs);
        return toolRuns ? { ...t, toolRuns } : t;
      }
      // Advisor custom messages are complete at message_start; message_end only
      // finalizes them when the start frame was missed (e.g. reconnect mid-stream).
      if (m?.role === "custom" && m.customType === "advisor") {
        const adv = parseAdvisory(typeof m.content === "string" ? m.content : "");
        if (adv) {
          const already = t.messages.some((v) => v.role === "system" && v.kind === "advisor" && v.text === adv.text);
          if (!already) {
            const view: ViewMessage = { key: `sys-${uid()}`, role: "system", text: adv.text, severity: adv.severity, guidance: adv.guidance, timestamp: m.timestamp, kind: "advisor" };
            return { ...t, messages: [...t.messages, view] };
          }
        }
        return t;
      }
      if (m?.role === "assistant" && t.streaming) {
        const final: ViewMessage = {
          ...t.streaming,
          provider: m.provider || t.streaming.provider,
          model: m.model || t.streaming.model,
          stopReason: m.stopReason,
          errorMessage: m.errorMessage,
          usage: m.usage || t.streaming.usage,
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
          const ci = ame.contentIndex;
          const id = ame.toolCall?.id || ame.partial?.content?.[ci]?.id;
          if (id) {
            const r = runs[id] || { id, name: "tool", args: {}, running: false, argsStr: "" };
            // omp streams the cumulative JSON string in partialArgs; prefer it
            // over concatenated fragments (fragment order/contiguity varies by
            // provider), falling back to delta appending when absent.
            const cumulative = typeof ame.partial?.content?.[ci]?.partialArgs === "string" ? ame.partial.content[ci].partialArgs : "";
            runs = { ...runs, [id]: { ...r, argsStr: cumulative || (r.argsStr || "") + (ame.delta || "") } };
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
          [id]: { ...prev, name: event.toolName || prev.name, args: event.args || prev.args, intent: event.intent, running: true, completed: false },
        },
      };
    }
    case "tool_execution_update": {
      const id = event.toolCallId;
      if (!id) return t;
      const prev = t.toolRuns[id] || { id, name: event.toolName || "tool", args: {}, running: true };
      const progress = Array.isArray(event.partialResult?.details?.progress)
        ? event.partialResult.details.progress
            .filter((p: any) => p && typeof p.id === "string" && typeof p.status === "string")
            .map((p: any) => ({ id: p.id, status: p.status }))
        : undefined;
      return {
        ...t,
        toolRuns: { ...t.toolRuns, [id]: { ...prev, partialText: textOfContent(event.partialResult?.content), ...(progress ? { progress } : {}) } },
      };
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
  /** Mirrors omp's display.showTokenUsage: show per-turn token usage on assistant messages. */
  showTokenUsage: boolean;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  /** True once bootstrap (config + projects + tab restore) has completed. */
  bootstrapped: boolean;

  // layout
  sidebarOpen: boolean;
  previewOpen: boolean;
  /** Preview occupies the chat workspace while preserving the mounted chat state. */
  previewExpanded: boolean;
  sidebarTab: "threads" | "files" | "git";

  // projects / threads
  activeProjectCwd: string | null;
  expandedProjects: Record<string, boolean>;
  openThreadIds: string[];
  /** Pinned tab ids (subset of openThreadIds); always sorted to the left. */
  pinnedThreadIds: string[];
  activeThreadId: string | null;
  /** Split view: thread shown in the LEFT pane (== activeThreadId when the left pane is focused). */
  primaryThreadId: string | null;
  /** Split view: thread shown in the RIGHT pane; null = single-pane layout. */
  paneThreadId: string | null;
  /** Bumped when chat should pin scroll to bottom (open history / reload). */
  chatScrollSeq: number;
  /** Sidebar flash target after "reveal in sidebar". */
  sidebarFlashThreadId: string | null;
  threads: Record<string, ThreadState>;
  /** Unsent composer text, keyed by thread id so each tab keeps its own draft. */
  drafts: Record<string, string>;

  // files / preview
  fileTree: Record<string, FileTreeEntry>;
  /** Working-tree git status per project cwd (for the file tree coloring). */
  gitFileStatus: Record<string, GitFileStatus>;
  previewPath: string | null;
  previewRoot: string | null;
  previewPayload: PreviewPayload | null;
  /** when set, the preview shows the file's diff in this commit instead of its working-tree content */
  previewCommitHash: string | null;
  previewLoading: boolean;

  // overlay
  toasts: Toast[];
  extuiQueue: { threadId: string; request: ExtUiRequest }[];

  // actions
  bootstrap: () => Promise<void>;
  /** Re-read omp's display.showTokenUsage from config.yml into showTokenUsage. */
  refreshShowTokenUsage: () => Promise<void>;
  /** Restore open tabs from localStorage after project discovery. */
  restoreOpenTabs: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  openProjectFolder: () => Promise<void>;
  openProjectPath: (path: string) => Promise<void>;
  unpinProject: (cwd: string) => Promise<void>;
  /** Remove a project from the sidebar: unpin if pinned, then archive it. */
  removeProject: (cwd: string) => Promise<void>;
  archiveProject: (cwd: string) => Promise<void>;
  restoreProject: (cwd: string) => Promise<void>;
  /** Permanently delete an archived project's session files. Irreversible. */
  deleteProject: (cwd: string) => Promise<void>;
  archiveThread: (cwd: string, file: string, title?: string) => Promise<void>;
  restoreThread: (file: string) => Promise<void>;
  /** Persist the sidebar top-level item order + user group memberships (see Sidebar drag). */
  applyProjectLayout: (order: string[], groups: Record<string, string[]>) => Promise<void>;
  /** Move sidebar items (project cwds or worktree container commonDirs) into a group (null = ungrouped), appending to the group. */
  moveItemsToGroup: (items: string[], group: string | null) => Promise<void>;
  createProjectGroup: (name: string) => Promise<void>;
  renameProjectGroup: (oldName: string, newName: string) => Promise<void>;
  deleteProjectGroup: (name: string) => Promise<void>;
  toggleProject: (cwd: string) => void;
  setActiveProject: (cwd: string) => void;

  openThread: (cwd: string, sessionFile?: string, permission?: PermissionLevel) => Promise<string | null>;
  /** Ensure a live omp process backs the thread (adopting the warm spare).
   *  Resolves with the thread id, or null if the connection failed. Safe to
   *  call repeatedly: concurrent calls share one in-flight connect. */
  ensureConnected: (threadId: string) => Promise<string | null>;
  /** Create a new thread in the active project, prompting for a folder if none is open. */
  newTask: () => Promise<void>;
  closeThread: (id: string) => Promise<void>;
  /** Confirm, then close a tab (shared by × / middle-click / Cmd+W). */
  requestCloseThread: (id: string) => Promise<void>;
  requestCloseOtherThreads: (keepId: string) => Promise<void>;
  requestCloseThreadsToRight: (id: string) => Promise<void>;
  requestCloseAllThreads: () => Promise<void>;
  setActiveThread: (id: string) => void;
  /** Show an open (hidden) tab in the right pane, enabling split view. */
  splitThreadIntoPane: (id: string) => void;
  /** Open a brand-new session in the right pane (left pane keeps its thread). */
  newTaskInSplit: () => Promise<void>;
  /** End split view: hide the right pane (its thread stays open in the tabs). */
  unsplitThread: () => void;
  /** Pin/unpin a tab; pinned tabs stay on the left and persist. */
  togglePinThread: (id: string) => void;
  /** Expand project in sidebar and scroll/highlight the thread row. */
  revealThreadInSidebar: (id: string) => void;
  /** Reorder open tabs; from/to are indexes into openThreadIds (pin groups clamped). */
  reorderOpenThreads: (fromIndex: number, toIndex: number) => void;
  /** Cycle the active tab by delta (+1 next, -1 previous). */
  cycleOpenThread: (delta: number) => void;
  sendPrompt: (threadId: string, text: string, images?: { data: string; mimeType: string }[], attachments?: { abs: string; name: string }[], mode?: "steer" | "followUp") => Promise<void>;
  setPendingFollowUp: (threadId: string, pending: PendingFollowUp | null) => void;
  sendPendingSteering: (threadId: string) => Promise<void>;
  abortThread: (id: string) => Promise<void>;
  refreshOpenThreadModels: () => Promise<void>;
  setComposerDraft: (id: string, text: string) => void;
  setModel: (id: string, provider: string, modelId: string) => Promise<void>;
  setThinking: (id: string, level: string) => Promise<void>;
  newSessionInThread: (id: string) => Promise<void>;
  renameThread: (id: string, name: string) => Promise<void>;

  setSidebarTab: (t: "threads" | "files" | "git") => void;
  toggleSidebar: () => void;
  /** Collapse/expand the todo panel above the composer for a thread. */
  setTodoCollapsed: (id: string, collapsed: boolean) => void;
  /** Collapse/expand the subagent panel above the composer for a thread. */
  setSubagentCollapsed: (id: string, collapsed: boolean) => void;
  togglePreview: () => void;
  togglePreviewExpanded: () => void;
  loadFileTree: (cwd: string, rel?: string) => Promise<void>;
  loadGitFileStatus: (cwd: string) => Promise<void>;
  toggleFolder: (cwd: string, rel: string) => void;
  openPreview: (abs: string, projectRoot?: string, commitHash?: string) => Promise<void>;
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
  /** Tab to open Settings on next open (set by update badge; cleared on close). */
  settingsInitialTab: string | null;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;

  // update availability (pushed from main; feeds the title-bar badges)
  updateStatus: { app: AppUpdateStatus | null; core: CoreUpdateStatus | null };
  setUpdateStatus: (s: { app: AppUpdateStatus | null; core: CoreUpdateStatus | null }) => void;

  // search overlay
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /** Open a thread by session file, or focus it if already open. */
  goToThread: (cwd: string, file: string) => Promise<void>;

  // worktree modal overlay (shared by Git panel and sidebar quick action)
  worktreeOpen: boolean;
  worktreeRoot: string | null;
  /** Branch the dialog defaults "From branch" to (the checkout clicked from). */
  worktreeBranch: string | null;
  openWorktreeFor: (cwd: string, branch?: string | null) => void;
  closeWorktree: () => void;

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

  // mcp overlay
  mcpOpen: boolean;
  mcpState: McpState | null;
  mcpLoading: boolean;
  openMcp: () => void;
  closeMcp: () => void;
  loadMcp: () => Promise<void>;
  saveMcpServer: (name: string, config: McpServerConfig) => Promise<void>;
  removeMcpServer: (name: string) => Promise<void>;
  setMcpServerEnabled: (name: string, enabled: boolean) => Promise<void>;
  setMcpLists: (disabledServers: string[], enabledServers: string[]) => Promise<void>;

  // thread permission / folder
  setPermission: (threadId: string, level: PermissionLevel) => Promise<void>;
  /** Toggle the session-level advisor (advisory notes) for a thread. */
  setAdvisor: (threadId: string, enabled: boolean) => Promise<void>;
  /**
   * Toggle plan mode for a thread: on switches the thread to the configured
   * plan-role model (modelRoles.plan), off restores the previous selection.
   */
  setPlanMode: (threadId: string, enabled: boolean) => Promise<void>;
  /** Delete the last exchange (final user prompt and its reply) from the session file, then reload the thread. */
  undoLastTurn: (threadId: string) => Promise<void>;
  /** Share the session file via omp share and copy the encrypted link to the clipboard. */
  shareThread: (threadId: string) => Promise<void>;
  reloadThread: (threadId: string) => Promise<void>;
  /** Move a not-yet-sent task to another working folder without losing the composer draft. */
  changeDraftThreadFolder: (threadId: string, cwd: string) => Promise<void>;

  // edit menu
  editAction: (action: "copy" | "cut" | "paste" | "delete" | "selectAll") => Promise<void>;
}

const treeKey = (cwd: string, rel?: string) => `${cwd}::${rel || ""}`;

/** In-flight background connects keyed by thread id, so a click and a
 *  same-tick prompt share one process boot instead of spawning two. */
const connectPromises = new Map<string, Promise<string | null>>();

/**
 * In-memory snapshot of the model/thinking a thread used before plan mode
 * switched it to the plan role, so toggling plan off restores exactly that
 * selection. Not persisted: after a restart the thread already holds the plan
 * model (the session persisted the model change), so off falls back to the
 * configured default role model.
 */
const planPrevSelections = new Map<string, { provider: string; id: string; thinking: string }>();

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
  showTokenUsage: true,
  projects: [],
  projectsLoading: false,
  bootstrapped: false,
  sidebarOpen: true,
  previewOpen: false,
  previewExpanded: false,
  sidebarTab: "threads",
  activeProjectCwd: null,
  expandedProjects: {},
  openThreadIds: [],
  pinnedThreadIds: [],
  activeThreadId: null,
  primaryThreadId: null,
  paneThreadId: null,
  chatScrollSeq: 0,
  sidebarFlashThreadId: null,
  threads: {},
  drafts: {},
  fileTree: {},
  gitFileStatus: {},
  previewPath: null,
  previewRoot: null,
  previewPayload: null,
  previewCommitHash: null,
  previewLoading: false,
  toasts: [],
  extuiQueue: [],
  settingsOpen: false,
  settingsInitialTab: null,
  updateStatus: { app: null, core: null },

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
        // Pre-warm the standby omp process for the active project so the first
        // "new task" adopts a booted process instead of cold-starting.
        window.pi.app.prewarm(projects[0].cwd).catch(() => {});
      }
    } else {
      get().pushToast("error", "Failed to load projects: " + (projectsResult.reason?.message || projectsResult.reason));
    }

    get().refreshShowTokenUsage().catch(() => {});

    await runtimeTask;
    try {
      await get().restoreOpenTabs();
    } catch (e: any) {
      get().pushToast("warning", "恢复会话标签失败：" + (e?.message || e));
    } finally {
      // Always unlock persistence, even if restore throws/hangs mid-way then recovers.
      openTabsHydrated = true;
      persistOpenTabs(get().openThreadIds, get().activeThreadId, get().pinnedThreadIds, get().primaryThreadId, get().paneThreadId);
      set({ bootstrapped: true });
    }
  },

  /** Re-read omp's display.showTokenUsage from config.yml into showTokenUsage. */
  refreshShowTokenUsage: async () => {
    try {
      const sections = (await window.pi.settings.getOmpConfig()) as OmpConfigSection[];
      const entry = sections
        ?.flatMap((s) => s.entries)
        .find((e) => e.key === "display.showTokenUsage");
      // omp defaults the flag to true; only an explicit false hides the chip.
      set({ showTokenUsage: entry?.value !== false });
    } catch {
      set({ showTokenUsage: true });
    }
  },

  /** Reopen previously open session tabs from localStorage (history first; connect only the active tab). */
  restoreOpenTabs: async () => {
    const saved = loadPersistedOpenTabs();
    const projects = get().projects;
    const fileToCwd = new Map<string, string>();
    for (const project of projects) {
      for (const thread of project.threads) fileToCwd.set(thread.file, project.cwd);
    }

    const wanted = (saved?.openThreadIds || []).filter((file) => fileToCwd.has(file));
    if (wanted.length === 0) {
      openTabsHydrated = true;
      persistOpenTabs(get().openThreadIds, get().activeThreadId, get().pinnedThreadIds, get().primaryThreadId, get().paneThreadId);
      return;
    }

    const restored: string[] = [];
    for (const sessionFile of wanted) {
      if (get().threads[sessionFile]) {
        restored.push(sessionFile);
        continue;
      }
      const cwd = fileToCwd.get(sessionFile);
      if (!cwd) continue;
      try {
        const hist: any = await window.pi.thread.loadHistory({ cwd, sessionFile });
        const { views, toolRuns } = historyToView(hist.messages || []);
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
          permission: hist.permission || "auto",
          advisory: hist.advisory ?? false,
          planMode: !!get().config?.threadPlanModes?.[hist.sessionFile || sessionFile],
        };
        set((s) => ({
          threads: { ...s.threads, [sessionFile]: thread },
        }));
        restored.push(sessionFile);
      } catch {
        /* session may have been deleted; skip */
      }
    }

    const active =
      (saved?.activeThreadId && restored.includes(saved.activeThreadId) && saved.activeThreadId) ||
      restored[restored.length - 1] ||
      null;
    const pinnedSaved = (saved?.pinnedThreadIds || []).filter((id) => restored.includes(id));
    const normalized = normalizeOpenTabOrder(restored, pinnedSaved);
    const activeSaved = active && normalized.openThreadIds.includes(active) ? active : normalized.openThreadIds[normalized.openThreadIds.length - 1] || null;
    const primarySaved =
      (saved?.primaryThreadId && restored.includes(saved.primaryThreadId) && saved.primaryThreadId) || activeSaved || null;
    const paneSaved =
      saved?.paneThreadId && restored.includes(saved.paneThreadId) && saved.paneThreadId !== primarySaved
        ? saved.paneThreadId
        : null;
    const finalActive = activeSaved && (activeSaved === primarySaved || activeSaved === paneSaved) ? activeSaved : primarySaved;

    set((s) => ({
      openThreadIds: normalized.openThreadIds,
      pinnedThreadIds: normalized.pinnedThreadIds,
      primaryThreadId: primarySaved,
      paneThreadId: paneSaved,
      activeThreadId: finalActive,
      activeProjectCwd: finalActive ? s.threads[finalActive]?.cwd || s.activeProjectCwd : s.activeProjectCwd,
      expandedProjects: finalActive && s.threads[finalActive]?.cwd
        ? { ...s.expandedProjects, [s.threads[finalActive]!.cwd]: true }
        : s.expandedProjects,
    }));

    openTabsHydrated = true;
    persistOpenTabs(normalized.openThreadIds, get().activeThreadId, normalized.pinnedThreadIds, get().primaryThreadId, get().paneThreadId);
    if (finalActive) get().ensureConnected(finalActive);
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
      await get().openProjectPath(path);
    } catch (e: any) {
      get().pushToast("error", "Open folder failed: " + (e?.message || e));
    }
  },

  /** Pin a directory as a project, refresh the sidebar, and switch to it. */
  openProjectPath: async (p) => {
    try {
      await window.pi.app.openProject(p);
      await get().refreshProjects();
      set({ activeProjectCwd: p, expandedProjects: { ...get().expandedProjects, [p]: true } });
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
  removeProject: async (cwd) => {
    const language = get().config?.language || "en";
    if (
      !window.confirm(
        language === "zh"
          ? "确定从侧栏移除该项目？不会删除文件夹或会话，可在设置的「已归档项目」中恢复。"
          : "Remove this project from the sidebar? The folder and sessions are not deleted; restore it from Archived projects in Settings.",
      )
    ) {
      return;
    }
    try {
      const cfg = get().config;
      const pinned = cfg?.pinnedProjects || [];
      if (pinned.includes(cwd)) {
        const config = await window.pi.app.setConfig({ pinnedProjects: pinned.filter((p) => p !== cwd) });
        set({ config });
      }
      await get().archiveProject(cwd);
    } catch (e: any) {
      get().pushToast("error", "移除项目失败：" + (e?.message || e));
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
  deleteProject: async (cwd) => {
    try {
      const res = await window.pi.app.deleteProject(cwd);
      if (!res?.ok) throw new Error(res?.error || "delete failed");
      const current = get().config;
      if (current) set({ config: await window.pi.app.getConfig() });
      await get().refreshProjects();
      get().pushToast(
        "success",
        res.removed > 0
          ? `已删除 ${res.removed} 个会话目录。`
          : "已删除项目记录（未找到会话目录）。",
      );
    } catch (e: any) {
      get().pushToast("error", "删除项目失败：" + (e?.message || e));
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
      get().pushToast("info", "会话已归档，可在设置的“归档会话”中恢复。");
    } catch (e: any) {
      get().pushToast("error", "归档会话失败：" + (e?.message || e));
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
      get().pushToast("success", "会话已恢复到侧栏。");
    } catch (e: any) {
      get().pushToast("error", "恢复会话失败：" + (e?.message || e));
    }
  },

  applyProjectLayout: async (order, groups) => {
    try {
      const config = await window.pi.app.setConfig({ projectOrder: order, projectGroups: groups });
      set({ config });
      await get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", "保存项目布局失败：" + (e?.message || e));
    }
  },
  moveItemsToGroup: async (items, group) => {
    const moving = new Set(items);
    const groups = { ...(get().config?.projectGroups || {}) };
    for (const [name, members] of Object.entries(groups)) {
      groups[name] = members.filter((m) => !moving.has(m));
    }
    let order = (get().config?.projectOrder || []).filter((e) => !moving.has(e));
    if (group) {
      const existing = (groups[group] || []).filter((m) => !moving.has(m));
      groups[group] = [...existing, ...items];
      if (!order.includes(group)) order.push(group);
    }
    await get().applyProjectLayout(order, groups);
  },
  createProjectGroup: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const groups = { ...(get().config?.projectGroups || {}) };
    if (groups[trimmed]) {
      get().pushToast("warning", `分组「${trimmed}」已存在。`);
      return;
    }
    groups[trimmed] = [];
    const order = [...(get().config?.projectOrder || [])];
    if (!order.includes(trimmed)) order.push(trimmed);
    await get().applyProjectLayout(order, groups);
  },
  renameProjectGroup: async (oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const groups = { ...(get().config?.projectGroups || {}) };
    if (groups[trimmed]) {
      get().pushToast("warning", `分组「${trimmed}」已存在。`);
      return;
    }
    if (!(oldName in groups)) return;
    groups[trimmed] = groups[oldName];
    delete groups[oldName];
    const order = (get().config?.projectOrder || []).map((e) => (e === oldName ? trimmed : e));
    await get().applyProjectLayout(order, groups);
  },
  deleteProjectGroup: async (name) => {
    const groups = { ...(get().config?.projectGroups || {}) };
    if (!(name in groups)) return;
    delete groups[name];
    const order = (get().config?.projectOrder || []).filter((e) => e !== name);
    await get().applyProjectLayout(order, groups);
  },

  toggleProject: (cwd) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [cwd]: !s.expandedProjects[cwd] } })),
  setActiveProject: (cwd) => set({ activeProjectCwd: cwd }),

  openThread: async (cwd, sessionFile, permission) => {
    // Already on screen: just activate. If it was only disk-rendered so far
    // (no live process yet), kick off / reuse the background connect so it
    // becomes interactive.
    if (sessionFile && get().threads[sessionFile]) {
      set((s) => {
        const openThreadIds = s.openThreadIds.includes(sessionFile)
          ? s.openThreadIds
          : [...s.openThreadIds, sessionFile];
        const normalized = normalizeOpenTabOrder(openThreadIds, s.pinnedThreadIds);
        const panes = panesForActivate(s, sessionFile);
        persistOpenTabs(normalized.openThreadIds, panes.activeThreadId, normalized.pinnedThreadIds, panes.primaryThreadId, panes.paneThreadId);
        return {
          ...panes,
          activeProjectCwd: cwd,
          expandedProjects: { ...s.expandedProjects, [cwd]: true },
          openThreadIds: normalized.openThreadIds,
          pinnedThreadIds: normalized.pinnedThreadIds,
        };
      });
      if (!get().threads[sessionFile].connected) get().ensureConnected(sessionFile);
      return sessionFile;
    }

    if (sessionFile) {
      // RESUMING an existing session. Its full transcript lives in the .jsonl
      // on disk, so render it instantly (milliseconds) and connect the pi
      // process in the background — no blocking "starting pi" spinner.
      try {
        const hist: any = await window.pi.thread.loadHistory({ cwd, sessionFile });
        const { views, toolRuns } = historyToView(hist.messages || []);
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
          permission: hist.permission || permission || "auto",
          advisory: hist.advisory ?? false,
          planMode: !!get().config?.threadPlanModes?.[hist.sessionFile || sessionFile],
        };
        set((s) => ({
          threads: { ...s.threads, [sessionFile]: thread },
          openThreadIds: s.openThreadIds.includes(sessionFile) ? s.openThreadIds : [...s.openThreadIds, sessionFile],
          ...panesForActivate(s, sessionFile),
          activeProjectCwd: hist.cwd || cwd,
          expandedProjects: { ...s.expandedProjects, [hist.cwd || cwd]: true },
          chatScrollSeq: s.chatScrollSeq + 1,
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
        get().pushToast("error", "打开会话失败：" + (e?.message || e));
        return null;
      }
    }

    // NEW TASK (no session file): nothing on disk to show, but the empty chat
    // + composer appear instantly and the omp process connects in the
    // background (adopting the warm spare). No blocking "starting pi" spinner.
    // The temp id is remapped to the real session file once connected.
    const tempId = `opening-${uid()}`;
    const placeholder: ThreadState = { ...emptyThread(cwd), loading: false, connected: false, permission: permission || "auto" };
    set((s) => ({
      threads: { ...s.threads, [tempId]: placeholder },
      openThreadIds: s.openThreadIds.includes(tempId) ? s.openThreadIds : [...s.openThreadIds, tempId],
      ...panesForActivate(s, tempId),
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
        const { views, toolRuns } = historyToView(res.messages || []);
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
            advisory: res.advisory ?? prev?.advisory ?? false,
            pendingEditorText: prev?.pendingEditorText,
            planMode: prev?.planMode ?? !!get().config?.threadPlanModes?.[res.sessionFile || t.sessionFile || id],
          };
          const threads: Record<string, ThreadState> = { ...s.threads, [id]: merged };
          let openThreadIds = s.openThreadIds;
          let pinnedThreadIds = s.pinnedThreadIds;
          let activeThreadId = s.activeThreadId;
          let primaryThreadId = s.primaryThreadId;
          let paneThreadId = s.paneThreadId;
          let drafts = s.drafts;
          if (id !== threadId) {
            delete threads[threadId];
            openThreadIds = openThreadIds.map((x) => (x === threadId ? id : x));
            pinnedThreadIds = pinnedThreadIds.map((x) => (x === threadId ? id : x));
            if (activeThreadId === threadId) activeThreadId = id;
            if (primaryThreadId === threadId) primaryThreadId = id;
            if (paneThreadId === threadId) paneThreadId = id;
            if (threadId in drafts) {
              drafts = { ...drafts, [id]: drafts[threadId] };
              delete drafts[threadId];
            }
          }
          return { threads, openThreadIds, pinnedThreadIds, activeThreadId, primaryThreadId, paneThreadId, drafts };
        });
        // A brand-new session just appeared on disk (temp id remapped to the
        // real session file); refresh the sidebar so it shows under its project.
        if (id !== threadId) get().refreshProjects();
        // Fresh thread: omp resolved the session model at process boot. If it
        // differs from the configured modelRoles.default, the default was
        // unusable (provider without credentials) and omp silently fell back.
        if (!t.sessionFile && res.model) {
          window.pi.settings
            .getModelRoles()
            .then((roles: Record<string, { provider: string; model: string }> | null) => {
              const role = roles?.default;
              if (!role?.provider || !role.model) return;
              const actual = res.model;
              if (actual.provider === role.provider && actual.id === role.model) return;
              const zh = get().config?.language === "zh";
              const usable = (res.models || []).some((m: any) => m.provider === role.provider && m.id === role.model);
              get().pushToast(
                "warning",
                usable
                  ? zh
                    ? `默认模型 ${role.provider}/${role.model} 未生效，当前会话使用 ${actual.provider}/${actual.id}`
                    : `Default model ${role.provider}/${role.model} was not applied; this session uses ${actual.provider}/${actual.id}`
                  : zh
                    ? `默认模型 ${role.provider}/${role.model} 不可用（供应商未配置凭证），已回退到 ${actual.provider}/${actual.id}`
                    : `Default model ${role.provider}/${role.model} is unavailable (provider has no credentials); fell back to ${actual.provider}/${actual.id}`,
              );
            })
            .catch(() => {});
        }
        window.pi.thread
          .getThinkingLevels(id)
          .then((r: any) => set((s) => (s.threads[id] ? { threads: { ...s.threads, [id]: { ...s.threads[id], levels: r?.levels || ["off"] } } } : s)))
          .catch(() => {});
        return id;
      } catch (e: any) {
        // Keep the disk-rendered transcript visible; only mark the failure.
        set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], connected: false, error: e?.message || "connect failed" } } } : s));
        get().pushToast("error", "连接 omp 进程失败：" + (e?.message || e));
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
      const pinnedThreadIds = s.pinnedThreadIds.filter((x) => x !== id);
      const threads = { ...s.threads };
      delete threads[id];
      let drafts = s.drafts;
      if (id in drafts) {
        drafts = { ...drafts };
        delete drafts[id];
      }
      const panes = panesForClose(s, id, openThreadIds[openThreadIds.length - 1] || null);
      const activeProjectCwd = panes.activeThreadId ? threads[panes.activeThreadId]?.cwd || null : null;
      const sidebarFlashThreadId = s.sidebarFlashThreadId === id ? null : s.sidebarFlashThreadId;
      persistOpenTabs(openThreadIds, panes.activeThreadId, pinnedThreadIds, panes.primaryThreadId, panes.paneThreadId);
      return { openThreadIds, pinnedThreadIds, threads, drafts, ...panes, activeProjectCwd, sidebarFlashThreadId };
    });
  },

  requestCloseThread: async (id) => {
    if (!get().openThreadIds.includes(id) && get().activeThreadId !== id) return;
    const streaming = !!get().threads[id]?.isStreaming;
    const msg = streaming
      ? "该会话正在生成回复。关闭将中断生成并停止后台进程，确定？"
      : "关闭此会话标签？后台 omp 进程会停止，侧栏可再次打开。";
    if (!window.confirm(msg)) return;
    await get().closeThread(id);
  },

  requestCloseOtherThreads: async (keepId) => {
    const others = get().openThreadIds.filter((id) => id !== keepId);
    if (others.length === 0) return;
    const streaming = others.some((id) => get().threads[id]?.isStreaming);
    const msg = streaming
      ? `将关闭其他 ${others.length} 个标签（含正在生成的会话）。确定？`
      : `关闭其他 ${others.length} 个会话标签？后台 omp 进程会停止，侧栏可再次打开。`;
    if (!window.confirm(msg)) return;
    for (const id of others) await get().closeThread(id);
  },

  requestCloseThreadsToRight: async (id) => {
    const idx = get().openThreadIds.indexOf(id);
    if (idx < 0) return;
    const right = get().openThreadIds.slice(idx + 1);
    if (right.length === 0) return;
    const streaming = right.some((tid) => get().threads[tid]?.isStreaming);
    const msg = streaming
      ? `将关闭右侧 ${right.length} 个标签（含正在生成的会话）。确定？`
      : `关闭右侧 ${right.length} 个会话标签？后台 omp 进程会停止，侧栏可再次打开。`;
    if (!window.confirm(msg)) return;
    for (const tid of right) await get().closeThread(tid);
  },

  requestCloseAllThreads: async () => {
    const all = [...get().openThreadIds];
    if (all.length === 0) return;
    const streaming = all.some((id) => get().threads[id]?.isStreaming);
    const msg = streaming
      ? `将关闭全部 ${all.length} 个标签（含正在生成的会话）。确定？`
      : `关闭全部 ${all.length} 个会话标签？后台 omp 进程会停止，侧栏可再次打开。`;
    if (!window.confirm(msg)) return;
    for (const id of all) await get().closeThread(id);
  },

  setActiveThread: (id) => {
    set((s) => {
      const cwd = s.threads[id]?.cwd;
      const openThreadIds = s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id];
      const normalized = normalizeOpenTabOrder(openThreadIds, s.pinnedThreadIds);
      const panes = panesForActivate(s, id);
      persistOpenTabs(normalized.openThreadIds, panes.activeThreadId, normalized.pinnedThreadIds, panes.primaryThreadId, panes.paneThreadId);
      if (cwd) {
        return {
          ...panes,
          activeProjectCwd: cwd,
          expandedProjects: { ...s.expandedProjects, [cwd]: true },
          openThreadIds: normalized.openThreadIds,
          pinnedThreadIds: normalized.pinnedThreadIds,
          chatScrollSeq: s.chatScrollSeq + 1,
        };
      }
      return {
        ...panes,
        openThreadIds: normalized.openThreadIds,
        pinnedThreadIds: normalized.pinnedThreadIds,
        chatScrollSeq: s.chatScrollSeq + 1,
      };
    });
    const t = get().threads[id];
    if (t && !t.connected && !t.loading) get().ensureConnected(id);
  },

  splitThreadIntoPane: (id) => {
    if (!get().openThreadIds.includes(id)) return;
    if (id === get().activeThreadId || id === get().primaryThreadId || id === get().paneThreadId) return;
    set({ paneThreadId: id, activeThreadId: id });
    const t = get().threads[id];
    if (t && !t.connected && !t.loading) get().ensureConnected(id);
  },

  newTaskInSplit: async () => {
    const before = get().activeThreadId;
    await get().newTask();
    const created = get().activeThreadId;
    if (!created || created === before) return;
    const s = get();
    // Already opened into the right pane (split focused right): nothing to move.
    if (s.paneThreadId === created) return;
    // Nothing was open before: a split needs two threads, stay single.
    if (before === null) return;
    // openThread routed the new session into the focused pane; move it right
    // and keep the previously focused thread on the left.
    set({ primaryThreadId: before, paneThreadId: created });
  },

  unsplitThread: () => {
    set((s) => {
      if (s.paneThreadId === null) return s;
      return {
        paneThreadId: null,
        activeThreadId: s.activeThreadId === s.paneThreadId ? s.primaryThreadId : s.activeThreadId,
      };
    });
  },

  togglePinThread: (id) => {
    set((s) => {
      if (!s.openThreadIds.includes(id) && s.activeThreadId !== id) return s;
      const openThreadIds = s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id];
      const pinned = s.pinnedThreadIds.includes(id)
        ? s.pinnedThreadIds.filter((x) => x !== id)
        : [...s.pinnedThreadIds, id];
      const normalized = normalizeOpenTabOrder(openThreadIds, pinned);
      persistOpenTabs(normalized.openThreadIds, s.activeThreadId, normalized.pinnedThreadIds, s.primaryThreadId, s.paneThreadId);
      return { openThreadIds: normalized.openThreadIds, pinnedThreadIds: normalized.pinnedThreadIds };
    });
  },

  revealThreadInSidebar: (id) => {
    const t = get().threads[id];
    if (!t) return;
    set((s) => ({
      sidebarOpen: true,
      sidebarTab: "threads",
      ...panesForActivate(s, id),
      activeProjectCwd: t.cwd,
      expandedProjects: { ...s.expandedProjects, [t.cwd]: true },
      sidebarFlashThreadId: id,
    }));
    window.setTimeout(() => {
      if (get().sidebarFlashThreadId === id) set({ sidebarFlashThreadId: null });
    }, 1800);
  },

  reorderOpenThreads: (fromIndex, toIndex) => {
    set((s) => {
      if (fromIndex === toIndex) return s;
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= s.openThreadIds.length || toIndex >= s.openThreadIds.length) return s;
      const pinnedSet = new Set(s.pinnedThreadIds);
      const movingId = s.openThreadIds[fromIndex];
      const movingPinned = pinnedSet.has(movingId);
      const pinnedCount = s.pinnedThreadIds.length;
      let clampedTo = toIndex;
      if (movingPinned) clampedTo = Math.min(Math.max(toIndex, 0), Math.max(0, pinnedCount - 1));
      else clampedTo = Math.min(Math.max(toIndex, pinnedCount), s.openThreadIds.length - 1);
      if (fromIndex === clampedTo) return s;
      const openThreadIds = [...s.openThreadIds];
      const [item] = openThreadIds.splice(fromIndex, 1);
      openThreadIds.splice(clampedTo, 0, item);
      const nextPinned = openThreadIds.filter((tid) => pinnedSet.has(tid));
      const normalized = normalizeOpenTabOrder(openThreadIds, nextPinned);
      persistOpenTabs(normalized.openThreadIds, s.activeThreadId, normalized.pinnedThreadIds, s.primaryThreadId, s.paneThreadId);
      return { openThreadIds: normalized.openThreadIds, pinnedThreadIds: normalized.pinnedThreadIds };
    });
  },

  cycleOpenThread: (delta) => {
    const { openThreadIds, activeThreadId } = get();
    if (openThreadIds.length < 2) return;
    const current = Math.max(0, openThreadIds.indexOf(activeThreadId || ""));
    const next = (current + delta + openThreadIds.length * 10) % openThreadIds.length;
    get().setActiveThread(openThreadIds[next]);
  },

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

  setComposerDraft: (id, text) =>
    set((s) => {
      if (!text) {
        if (!(id in s.drafts)) return s;
        const drafts = { ...s.drafts };
        delete drafts[id];
        return { drafts };
      }
      return { drafts: { ...s.drafts, [id]: text } };
    }),

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
      const { views, toolRuns } = historyToView(res.messages || []);
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
        permission: res.permission || get().threads[id]?.permission || "auto",
        advisory: res.advisory ?? get().threads[id]?.advisory ?? false,
      };
      set((s) => {
        const threads: Record<string, ThreadState> = { ...s.threads, [newId]: thread };
        if (newId !== id) delete threads[id];
        const openThreadIds = s.openThreadIds.map((x) => (x === id ? newId : x));
        const pinnedThreadIds = s.pinnedThreadIds.map((x) => (x === id ? newId : x));
        return {
          threads,
          openThreadIds,
          pinnedThreadIds,
          activeThreadId: newId,
          primaryThreadId: s.primaryThreadId === id ? newId : s.primaryThreadId,
          paneThreadId: s.paneThreadId === id ? newId : s.paneThreadId,
        };
      });
      if (newId !== id) get().refreshProjects();
    } catch (e: any) {
      get().pushToast("error", e?.message || "new session failed");
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
  setTodoCollapsed: (id, collapsed) =>
    set((s) => {
      const t = s.threads[id];
      if (!t || (t.todoCollapsed ?? false) === collapsed) return s;
      return { threads: { ...s.threads, [id]: { ...t, todoCollapsed: collapsed } } };
    }),
  setSubagentCollapsed: (id, collapsed) =>
    set((s) => {
      const t = s.threads[id];
      if (!t || (t.subagentCollapsed ?? false) === collapsed) return s;
      return { threads: { ...s.threads, [id]: { ...t, subagentCollapsed: collapsed } } };
    }),
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
  loadGitFileStatus: async (cwd) => {
    try {
      const status = await window.pi.app.getGitFileStatus(cwd);
      set((s) => ({ gitFileStatus: { ...s.gitFileStatus, [cwd]: status } }));
    } catch {
      /* non-git project or git unavailable: leave empty */
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

  openPreview: async (abs, projectRoot, commitHash) => {
    const root = projectRoot || get().previewRoot || undefined;
    set({
      previewOpen: true,
      previewPath: abs,
      previewRoot: root || null,
      previewCommitHash: commitHash || null,
      // Commit mode shows a diff only — no working-tree payload fetch (the
      // file's on-disk content is not what that commit contains).
      previewLoading: !commitHash,
      previewPayload: null,
    });
    if (commitHash) return;
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
      previewCommitHash: null,
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
    if (m === "setStatus" || m === "setWidget") {
      set((s) => {
        const t = s.threads[threadId];
        if (!t) return s;
        // omp RPC fields: setStatus -> statusKey/statusText, setWidget -> widgetKey/widgetLines (string[]).
        // Legacy pi field names kept as fallbacks.
        if (m === "setWidget") {
          const key = String(req.widgetKey ?? req.name ?? "widget");
          const lines = req.widgetLines;
          const next = { ...(t.extWidgets || {}) };
          if (lines === undefined) {
            delete next[key];
            return { threads: { ...s.threads, [threadId]: { ...t, extWidgets: next } } };
          }
          next[key] = Array.isArray(lines) ? lines.join("\n") : String(lines);
          return { threads: { ...s.threads, [threadId]: { ...t, extWidgets: next } } };
        }
        const status = req.statusText ?? req.text ?? req.message ?? req.title;
        const key = String(req.statusKey ?? "status");
        const next = { ...(t.extStatuses || {}) };
        if (status === undefined) {
          delete next[key];
          return { threads: { ...s.threads, [threadId]: { ...t, extStatuses: next } } };
        }
        next[key] = String(status).replace(/\u001b\[[0-9;]*m/g, "");
        return { threads: { ...s.threads, [threadId]: { ...t, extStatuses: next } } };
      });
      return;
    }
    // dialog methods -> queue
    if (m === "select" || m === "confirm" || m === "input" || m === "editor") {
      set((s) => ({
        extuiQueue: [...s.extuiQueue, { threadId, request: req }],
        // Confirmation cards belong above the relevant thread's composer.
        ...((m === "select" || m === "confirm") && s.threads[threadId] ? panesForActivate(s, threadId) : {}),
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
      return { threads: { ...s.threads, [threadId]: { ...t, isStreaming: false, streaming: null, error: `omp exited (code ${info.code})` } } };
    });
    const tail = (info.stderr || "").trim().split(/\r?\n/).slice(-3).join(" | ");
    get().pushToast("error", `omp process exited (${info.code})${tail ? ": " + tail : ""}`);
  },

  handleError: (threadId, message) => {
    set((s) => {
      const t = s.threads[threadId];
      if (!t) return s;
      return { threads: { ...s.threads, [threadId]: { ...t, error: message } } };
    });
    get().pushToast("error", message);
  },

  openSettings: (tab?: string) =>
    set({ settingsOpen: true, settingsInitialTab: typeof tab === "string" ? tab : null }),
  closeSettings: () => set({ settingsOpen: false, settingsInitialTab: null }),
  setUpdateStatus: (s) => set({ updateStatus: s }),

  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  // ---- worktree modal overlay ----
  worktreeOpen: false,
  worktreeRoot: null,
  worktreeBranch: null,
  openWorktreeFor: (cwd, branch) => set({ worktreeRoot: cwd, worktreeBranch: branch || null, worktreeOpen: true }),
  closeWorktree: () => set({ worktreeOpen: false, worktreeRoot: null, worktreeBranch: null }),
  goToThread: async (cwd, file) => {
    const s = get();
    if (s.openThreadIds.includes(file)) {
      set((st) => ({
        ...panesForActivate(st, file),
        activeProjectCwd: cwd,
        expandedProjects: { ...st.expandedProjects, [cwd]: true },
        chatScrollSeq: st.chatScrollSeq + 1,
      }));
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
      const res: any = await window.pi.plugins.removePackage(source);
      if (res && res.ok === false) {
        get().pushToast("error", "移除失败：" + (res.output || "unknown error"));
      }
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

  // ---- mcp servers ----
  mcpOpen: false,
  mcpState: null,
  mcpLoading: false,
  openMcp: () => {
    set({ mcpOpen: true });
    get().loadMcp();
  },
  closeMcp: () => set({ mcpOpen: false }),
  loadMcp: async () => {
    set({ mcpLoading: true });
    try {
      // Fast path: aggregated list with cached statuses. Connection probing is
      // async (spawns stdio servers) so render immediately, then refresh when
      // the probe finishes.
      const mcpState = await window.pi.mcp.getServers();
      set({ mcpState, mcpLoading: false });
      const probed = await window.pi.mcp.probeServers();
      set({ mcpState: probed });
    } catch (e: any) {
      set({ mcpLoading: false });
      get().pushToast("error", "加载 MCP 服务器失败：" + (e?.message || e));
    }
  },
  saveMcpServer: async (name, config) => {
    try {
      const mcpState = await window.pi.mcp.saveServer(name, config);
      set({ mcpState });
    } catch (e: any) {
      get().pushToast("error", "保存失败：" + (e?.message || e));
      throw e; // let the panel keep the draft open instead of losing input
    }
  },
  removeMcpServer: async (name) => {
    try {
      const mcpState = await window.pi.mcp.removeServer(name);
      set({ mcpState });
    } catch (e: any) {
      get().pushToast("error", "移除失败：" + (e?.message || e));
    }
  },
  setMcpServerEnabled: async (name, enabled) => {
    // Optimistic flip; main reconciles the authoritative state.
    set((s) =>
      s.mcpState
        ? { mcpState: { ...s.mcpState, servers: s.mcpState.servers.map((sv) => (sv.name === name ? { ...sv, enabled } : sv)) } }
        : s,
    );
    try {
      const mcpState = await window.pi.mcp.setServerEnabled(name, enabled);
      set({ mcpState });
    } catch (e: any) {
      get().pushToast("error", "切换失败：" + (e?.message || e));
      get().loadMcp();
    }
  },
  setMcpLists: async (disabledServers, enabledServers) => {
    try {
      const mcpState = await window.pi.mcp.setLists(disabledServers, enabledServers);
      set({ mcpState });
    } catch (e: any) {
      get().pushToast("error", "保存失败：" + (e?.message || e));
    }
  },

  // ---- thread permission / folder ----
  setPermission: async (threadId, level) => {
    const t = get().threads[threadId];
    if (!t || t.permission === level) return;
    set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], permission: level } } } : s));
    try {
      // The gate extension is always loaded; switching just flips its live mode
      // file, so the omp process and session keep running uninterrupted.
      await window.pi.thread.setPermission({ threadId, permission: level });
      get().pushToast(
        "info",
        level === "sandbox"
          ? "已切换到 sandbox（非只读命令及项目外写入需确认）。"
          : level === "auto"
            ? "已开启自动审批：常规操作自动放行，危险操作仍需确认。"
            : "已切换到完全权限。",
      );
    } catch (e: any) {
      get().pushToast("error", "切换权限失败：" + (e?.message || e));
    }
  },
  setAdvisor: async (threadId, enabled) => {
    const t = get().threads[threadId];
    if (!t || t.advisory === enabled) return;
    set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], advisory: enabled } } } : s));
    try {
      // Main flips the live session via omp's `/advisor` command and persists
      // the preference per session file (re-applied on the next open).
      await window.pi.thread.setAdvisor({ threadId, enabled });
      get().pushToast("info", enabled ? "已开启会话 advisory（advisor 建议会注入对话）。" : "已关闭会话 advisory（不再收到 advisor 建议）。");
    } catch (e: any) {
      get().pushToast("error", "切换 advisory 失败：" + (e?.message || e));
    }
  },
  setPlanMode: async (threadId, enabled) => {
    const t = get().threads[threadId];
    if (!t || !!t.planMode === enabled) return;
    const zh = get().config?.language === "zh";
    const persist = async (on: boolean) => {
      const key = t.sessionFile || (threadId.startsWith("opening-") ? "" : threadId);
      if (!key) return;
      try {
        const modes = { ...(get().config?.threadPlanModes || {}) };
        if (on) modes[key] = true;
        else delete modes[key];
        set({ config: await window.pi.app.setConfig({ threadPlanModes: modes }) });
      } catch {
        /* persistence is best-effort */
      }
    };
    if (enabled) {
      let roles: Record<string, { provider: string; model: string; level?: string }> | null = null;
      try {
        roles = await window.pi.settings.getModelRoles();
      } catch {
        /* fall through */
      }
      const plan = roles?.plan;
      if (!plan?.provider || !plan.model) {
        get().pushToast(
          "warning",
          zh ? "未配置规划角色模型（设置 → 模型角色 → plan），无法进入规划模式" : "No plan-role model configured (Settings → model roles → plan); plan mode unavailable",
        );
        return;
      }
      // Snapshot the current selection so plan mode can be undone exactly.
      planPrevSelections.set(threadId, { provider: t.model?.provider ?? "", id: t.model?.id ?? "", thinking: t.thinking });
      // Switch model first; only mark plan mode on when the runtime accepted it.
      await get().setModel(threadId, plan.provider, plan.model);
      const after = get().threads[threadId]?.model;
      if (!after || after.provider !== plan.provider || after.id !== plan.model) {
        planPrevSelections.delete(threadId);
        return; // setModel already toasted the failure
      }
      if (plan.level) await get().setThinking(threadId, plan.level);
      set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], planMode: true } } } : s));
      await persist(true);
      get().pushToast("info", zh ? "已进入规划模式：模型切换到 plan 角色。" : "Plan mode on: switched to the plan-role model.");
    } else {
      const prev = planPrevSelections.get(threadId);
      planPrevSelections.delete(threadId);
      if (prev?.provider && prev.id) {
        await get().setModel(threadId, prev.provider, prev.id);
        await get().setThinking(threadId, prev.thinking);
      } else {
        // No in-session snapshot (e.g. restored after restart): fall back to the
        // configured default role model.
        try {
          const roles: Record<string, { provider: string; model: string }> | null = await window.pi.settings.getModelRoles();
          const def = roles?.default;
          if (def?.provider && def.model) {
            await get().setModel(threadId, def.provider, def.model);
          }
        } catch {
          /* best-effort restore */
        }
      }
      set((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], planMode: false } } } : s));
      await persist(false);
      get().pushToast("info", zh ? "已退出规划模式，恢复原模型。" : "Plan mode off: previous model restored.");
    }
  },
  undoLastTurn: async (threadId) => {
    const t = get().threads[threadId];
    if (!t) return;
    if (t.isStreaming) {
      get().pushToast("warning", "请等待当前回复结束后再撤销。");
      return;
    }
    if (!t.sessionFile) {
      get().pushToast("warning", "会话尚未落盘，暂无可撤销内容。");
      return;
    }
    if (!t.messages.some((m) => m.role === "user")) {
      get().pushToast("warning", "没有可撤销的对话。");
      return;
    }
    try {
      const res = await window.pi.thread.undoLastTurn({ sessionFile: t.sessionFile });
      if (!res.ok) {
        get().pushToast("error", res.message || "撤销失败");
        return;
      }
      await get().reloadThread(threadId);
      void get().refreshProjects();
      get().pushToast("info", "已撤销最近一次对话");
    } catch (e) {
      get().pushToast("error", "撤销失败：" + (e instanceof Error ? e.message : String(e)));
    }
  },
  shareThread: async (threadId) => {
    const t = get().threads[threadId];
    if (!t) return;
    if (t.isStreaming) {
      get().pushToast("warning", "请等待当前回复结束后再分享。");
      return;
    }
    if (!t.sessionFile) {
      get().pushToast("warning", "会话尚未落盘，暂无可分享内容。");
      return;
    }
    try {
      const res = await window.pi.thread.share({ sessionFile: t.sessionFile });
      if (!res.ok || !res.url) {
        get().pushToast("error", res.message || "分享失败");
        return;
      }
      try {
        await navigator.clipboard.writeText(res.url);
      } catch {
        // Clipboard may be unavailable (e.g. no focus); the toast still shows the link.
      }
      get().pushToast("success", `已生成分享链接并复制：${res.url}`);
    } catch (e) {
      get().pushToast("error", "分享失败：" + (e instanceof Error ? e.message : String(e)));
    }
  },
  reloadThread: async (threadId) => {
    const t = get().threads[threadId];
    if (!t) return;
    if (t.loading) return;
    if (t.isStreaming) {
      get().pushToast("warning", "请等待当前回复结束后再重新加载。");
      return;
    }
    const cwd = t.cwd;
    const sessionFile = t.sessionFile || (threadId.startsWith("opening-") ? "" : threadId);
    const permission = t.permission;
    if (!sessionFile) {
      get().pushToast("warning", "会话尚未落盘，暂无可重新加载的历史。");
      return;
    }

    // Keep the chat mounted: only mark disconnected so the existing "连接中"
    // badge shows. Setting loading:true used to early-return Chat past hooks.
    set((s) => {
      const prev = s.threads[threadId];
      if (!prev) return {};
      const next: ThreadState = {
        ...prev,
        connected: false,
        isStreaming: false,
        streaming: null,
        error: undefined,
      };
      return { threads: { ...s.threads, [threadId]: next } };
    });

    try {
      await window.pi.thread.close(threadId);
    } catch {
      /* ignore */
    }
    if (sessionFile !== threadId) {
      try {
        await window.pi.thread.close(sessionFile);
      } catch {
        /* ignore */
      }
    }
    connectPromises.delete(threadId);
    connectPromises.delete(sessionFile);

    try {
      const hist: any = await window.pi.thread.loadHistory({ cwd, sessionFile });
      const { views, toolRuns } = historyToView(hist.messages || []);
      const nextId = hist.sessionFile || sessionFile;
      const thread: ThreadState = {
        ...emptyThread(hist.cwd || cwd),
        sessionFile: nextId,
        sessionName: hist.sessionName,
        model: hist.model,
        models: hist.models || [],
        thinking: hist.thinkingLevel || "off",
        commands: hist.commands || [],
        loading: false,
        connected: false,
        messages: views,
        toolRuns,
        permission: hist.permission || permission || "auto",
        advisory: hist.advisory ?? false,
        planMode: !!get().config?.threadPlanModes?.[nextId],
      };
      set((s) => {
        const threads: Record<string, ThreadState> = { ...s.threads, [nextId]: thread };
        if (threadId !== nextId) delete threads[threadId];
        const openThreadIds = s.openThreadIds.map((x) => (x === threadId ? nextId : x));
        const pinnedThreadIds = s.pinnedThreadIds.map((x) => (x === threadId ? nextId : x));
        const activeThreadId = s.activeThreadId === threadId ? nextId : s.activeThreadId;
        const primaryThreadId = s.primaryThreadId === threadId ? nextId : s.primaryThreadId;
        const paneThreadId = s.paneThreadId === threadId ? nextId : s.paneThreadId;
        persistOpenTabs(openThreadIds, activeThreadId, pinnedThreadIds, primaryThreadId, paneThreadId);
        return {
          threads,
          openThreadIds,
          pinnedThreadIds,
          primaryThreadId,
          paneThreadId,
          activeThreadId,
          activeProjectCwd: hist.cwd || cwd,
          chatScrollSeq: s.chatScrollSeq + 1,
        };
      });
      await get().ensureConnected(nextId);
      get().pushToast("info", "会话已重新加载");
    } catch (e: any) {
      get().pushToast("error", "重新加载失败：" + (e?.message || e));
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
      // reliably. The composer draft moves to the replacement thread below.
      const oldId = (await get().ensureConnected(threadId)) || threadId;
      await window.pi.app.openProject(cwd);
      await get().refreshProjects();
      const newId = await get().openThread(cwd, undefined, original.permission);
      if (!newId) return;
      const draft = get().drafts[oldId];
      if (draft) get().setComposerDraft(newId, draft);
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

useStore.subscribe((state, prev) => {
  if (
    state.openThreadIds === prev.openThreadIds &&
    state.activeThreadId === prev.activeThreadId &&
    state.pinnedThreadIds === prev.pinnedThreadIds &&
    state.primaryThreadId === prev.primaryThreadId &&
    state.paneThreadId === prev.paneThreadId
  ) {
    // still sync active tab for desktop notify
  } else {
    persistOpenTabs(state.openThreadIds, state.activeThreadId, state.pinnedThreadIds, state.primaryThreadId, state.paneThreadId);
  }
  // Keep main-process desktop-notify suppression in sync with the active tab.
  if (state.activeThreadId !== prev.activeThreadId) {
    window.pi.app.setActiveThread(state.activeThreadId).catch(() => {});
  }
});
