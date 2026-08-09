/** Shared renderer-side types. Pi message shapes are kept loose (`any`) because
 *  the renderer intentionally has no dependency on the pi packages. */

export interface ThreadSummary {
  file: string;
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  threads: ThreadSummary[];
}

export interface ArchivedThread {
  file: string;
  cwd: string;
  title: string;
}

/** A full-text search hit across session transcripts. */
export interface ThreadSearchHit {
  file: string;
  cwd: string;
  title: string;
  projectName: string;
  updatedAt: number;
  messageCount: number;
  snippet: string;
  matchCount: number;
}

/** Thread permission level. Sandbox gates risky shell, out-of-project writes, subagents, and unclassified extension tools; full is unrestricted. */
export type PermissionLevel = "sandbox" | "full";

/** An installed pi package (from settings.json `packages`). */
export interface PluginPackage {
  /** Raw source spec, e.g. "npm:foo", "git:host/repo@ref", or a local path. */
  source: string;
  /** Display name derived from the source. */
  name: string;
  kind: "npm" | "git" | "local";
  /** True when the package loads its resources; false when disabled via autoload=false. */
  enabled: boolean;
  /** Installed version, when known (npm/git packages). */
  version?: string;
}

/** A standalone skill discovered in a skills directory. */
export interface SkillInfo {
  name: string;
  path: string;
  /** The root directory it was discovered under. */
  root: string;
  enabled: boolean;
}

export type ScheduleFrequency = "hourly" | "daily" | "weekly";

export interface TaskSchedule {
  frequency: ScheduleFrequency;
  /** hourly: minute of the hour (0-59). */
  minute?: number;
  /** daily/weekly: "HH:MM" (24h). */
  time?: string;
  /** weekly: days of week, 0=Sun .. 6=Sat. */
  days?: number[];
}

export interface AutomationTask {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  schedule: TaskSchedule;
  enabled: boolean;
  permission: PermissionLevel;
  lastRunAt?: number;
  lastRunSlot?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  /** Maps the UI effort level to the provider-specific effort value. */
  thinkingLevelMap?: Record<string, string | null>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: any };

export interface ViewMessage {
  /** stable key */
  key: string;
  /** Stable Pi session entry id used by message-level branching. */
  branchEntryId?: string;
  role: "user" | "assistant" | "system";
  timestamp?: number;
  /** user/system plain text (may include image blocks for user) */
  text?: string;
  images?: { dataUrl: string; mimeType: string }[];
  /** assistant structured blocks */
  blocks?: ContentBlock[];
  /** how a user message was submitted while the agent was working */
  sendKind?: "steer" | "followUp";
  /** provider/model for assistant footer */
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface ToolRun {
  id: string;
  name: string;
  args: any;
  running: boolean;
  /** True after Pi emits a tool result, including an empty successful result. */
  completed?: boolean;
  isError?: boolean;
  resultText?: string;
  partialText?: string;
  argsStr?: string;
}

/** A follow-up the user queued (Enter) while the agent is streaming. Held in
 * the renderer so it can be re-edited or promoted to steering before delivery. */
export interface PendingFollowUp {
  text: string;
  images: PendingImage[];
  files: PendingFile[];
}

export interface ThreadState {
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  model: ModelInfo | null;
  models: ModelInfo[];
  thinking: string;
  levels: string[];
  commands: any[];
  /** True while the backing omp process is still booting (optimistic open). */
  loading?: boolean;
  /** True once a live omp process backs this thread. A thread can show its full
   *  transcript (read from disk) while still disconnected; interaction connects. */
  connected?: boolean;
  isStreaming: boolean;
  messages: ViewMessage[];
  streaming: ViewMessage | null;
  toolRuns: Record<string, ToolRun>;
  error?: string;
  /** Permission level the thread's omp process runs under. */
  permission: PermissionLevel;
  /** text injected by an extension via set_editor_text */
  pendingEditorText?: string;
  /** Follow-up queued via Enter while streaming; delivered when the agent settles. */
  pendingFollowUp?: PendingFollowUp | null;
  /** Status lines pushed by extensions via setStatus (e.g. usage cache stats), keyed by statusKey. */
  extStatuses?: Record<string, string>;
  /** Named widgets pushed by an extension via setWidget. */
  extWidgets?: Record<string, string>;
  /** Whether the todo panel above the composer is collapsed for this thread. */
  todoCollapsed?: boolean;
}

export interface PreviewPayload {
  name: string;
  ext: string;
  size: number;
  kind: "text" | "markdown" | "html" | "image" | "docx" | "xlsx" | "pptx" | "unsupported" | "toobig" | "missing";
  mime?: string;
  text?: string;
  base64?: string;
  lang?: string;
  truncated?: boolean;
  message?: string;
  /** Isolated pi-preview:// URL used for HTML plus its local CSS/JS/assets. */
  previewUrl?: string;
}

export interface FileDiffResult {
  ok: boolean;
  diff: string;
  /** true when the file is untracked, or the repo has no commits yet */
  newFile: boolean;
  error?: string;
}

export interface ExtUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  text?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

export interface DesktopNotifyConfig {
  enabled: boolean;
  onIdle: boolean;
  onApproval: boolean;
  onError: boolean;
  onlyWhenUnfocused: boolean;
}

export interface AppConfig {
  /** Path to the omp (oh-my-pi) binary, or empty string to auto-detect. */
  ompBinPath: string;
  pinnedProjects: string[];
  archivedProjects: string[];
  archivedThreads: ArchivedThread[];
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  theme: "dark" | "light" | "system";
  language: "en" | "zh";
  desktopNotify?: DesktopNotifyConfig;
}

export interface AppRuntime {
  ok: boolean;
  bin?: string;
  version?: string;
  error?: string;
}

/** Read-only snapshot of the omp runtime + config locations, for the Settings panel. */
export interface Diagnostics {
  bin: string | null;
  ompVersion: string | null;
  agentDir: string;
  sessionsDir: string;
  settingsPath: string;
  authPath: string;
  modelsPath: string;
  settingsExists: boolean;
  authExists: boolean;
  modelsExists: boolean;
  /** Where the active omp runtime came from. */
  runtimeKind: "override" | "userData" | "bundled" | "system" | "unknown";
  /** True when the runtime is managed by the app (bundled or app-updated). */
  bundled: boolean;
  error: string | null;
}

/** Push payload of `pi:updateStatus`: app + omp-core update availability. */
export interface AppUpdateStatus {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  supported: boolean;
  installable: boolean;
  downloaded: boolean;
  note?: string | null;
  error?: string;
}

export interface CoreUpdateStatus {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  note?: string | null;
  error?: string;
}

export type ApiType = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** A single model entry inside a provider's `models` array (models.json). */
export interface ModelDef {
  id: string;
  name?: string;
  api?: ApiType;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  /** preserve any unknown fields verbatim on round-trip */
  [key: string]: unknown;
}

/** A provider entry in models.json. */
export interface ProviderDef {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: ModelDef[];
  modelOverrides?: Record<string, unknown>;
  oauth?: unknown;
  [key: string]: unknown;
}

/** Top-level shape of ~/.omp/agent/models.yml (custom providers). */
export interface ModelsFile {
  providers: Record<string, ProviderDef>;
  [key: string]: unknown;
}

/** The thinking-related slice of settings.json that the GUI edits. */
export interface ThinkingDefaults {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  hideThinkingBlock?: boolean;
}

export interface FileNode {
  name: string;
  rel: string;
  abs: string;
  isDir: boolean;
  ext: string;
  size: number;
}

export interface GitFileEntry {
  path: string;
  status: string;
}

export interface GitStatusResult {
  repo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  short: string;
  author: string;
  rel: string;
  refs: string;
  subject: string;
}

export interface GitOpResult {
  ok: boolean;
  error?: string;
  output?: string;
}

/** A pasted/dropped image held in the composer before sending (base64). */
export interface PendingImage {
  id: string;
  dataUrl: string;
  base64: string;
  mimeType: string;
}

/** A local file attached in the composer (absolute path resolved by main). */
export interface PendingFile {
  abs: string;
  name: string;
}

/** A single MCP server definition in mcp.json (stdio/http/sse). */
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

export type McpSource = "omp" | "claude" | "codex";

export interface McpServerInfo {
  name: string;
  /** Where the server came from: OMP's own mcp.json or a discovered source. */
  source: McpSource;
  /** Effective state: enabled flag in config AND not denylisted. */
  enabled: boolean;
  type: "stdio" | "http" | "sse" | "other";
  /** Command (stdio) or URL (http/sse) shown in the list. Empty for discovered servers. */
  endpoint: string;
  /** Live probe result: connected / not connected / disabled (denylisted or enabled:false). */
  status: "connected" | "not-connected" | "disabled";
  /** True when the name comes from disabledServers/enabledServers (discovered elsewhere) rather than a config source. */
  discovered: boolean;
  config: McpServerConfig;
}

export interface McpState {
  path: string;
  servers: McpServerInfo[];
  disabledServers: string[];
  enabledServers: string[];
  /** The three config sources, in display order, with their paths. */
  sources: { id: McpSource; path: string }[];
}

/** One omp config.yml key surfaced by the schema-driven settings editor. */
export interface OmpConfigEntry {
  key: string;
  type: string;
  /** Resolved value from `omp config list --json`; absent when unset. */
  value?: unknown;
  description: string;
  /** Enum choices (type === "enum"). */
  options?: string[];
}

export type OmpConfigSectionId = "appearance" | "context" | "files" | "interaction" | "model" | "memory" | "providers" | "advanced";

export interface OmpConfigSection {
  id: OmpConfigSectionId;
  entries: OmpConfigEntry[];
}

/** Composer prompt enhancement result (project-aware restructure). */
export interface EnhancePromptResult {
  /** Restructured prompt, ready to send. */
  prompt: string;
  /** Short summary of the project context the model used. */
  contextUsed: string;
}
