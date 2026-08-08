import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/**
 * The renderer talks to the main process exclusively through this surface.
 * Keep it narrow and typed; the matching declaration lives in index.d.ts.
 */

type Unsub = () => void;
function on(channel: string, cb: (payload: any) => void): Unsub {
  const listener = (_e: IpcRendererEvent, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
    getConfig: () => ipcRenderer.invoke("app:getConfig"),
    setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("app:setConfig", patch),
    setActiveThread: (threadId: string | null) => ipcRenderer.invoke("app:setActiveThread", threadId),
    resolveRuntime: () => ipcRenderer.invoke("app:resolveRuntime"),
    getProjects: () => ipcRenderer.invoke("app:getProjects"),
    searchThreads: (query: string) => ipcRenderer.invoke("app:searchThreads", query),
    getTotalUsage: () => ipcRenderer.invoke("app:getTotalUsage"),
    getGitBranch: (cwd: string) => ipcRenderer.invoke("app:getGitBranch", cwd),
    getGitInfo: (cwd: string) => ipcRenderer.invoke("app:getGitInfo", cwd),
    openProject: (absPath: string) => ipcRenderer.invoke("app:openProject", absPath),
    prewarm: (cwd: string) => ipcRenderer.invoke("app:prewarm", cwd),
    unpinProject: (absPath: string) => ipcRenderer.invoke("app:unpinProject", absPath),
    deleteProject: (cwd: string) => ipcRenderer.invoke("app:deleteProject", cwd),
    showOpenDialog: (kind: "folder" | "file" | "files") => ipcRenderer.invoke("app:showOpenDialog", kind),
    getFileTree: (cwd: string, rel?: string) => ipcRenderer.invoke("app:getFileTree", cwd, rel),
    searchProjectFiles: (cwd: string, query: string, limit?: number) =>
      ipcRenderer.invoke("app:searchProjectFiles", cwd, query, limit),
    fileExists: (absPath: string) => ipcRenderer.invoke("app:fileExists", absPath),
    readPreview: (absPath: string, projectRoot?: string) => ipcRenderer.invoke("app:readPreview", absPath, projectRoot),
    showFileContextMenu: (absPath: string) => ipcRenderer.invoke("app:showFileContextMenu", absPath),
    updatePi: () => ipcRenderer.invoke("app:updatePi"),
    checkAppUpdate: () => ipcRenderer.invoke("app:checkAppUpdate"),
    downloadAppUpdate: () => ipcRenderer.invoke("app:downloadAppUpdate"),
    installAppUpdate: () => ipcRenderer.invoke("app:installAppUpdate"),
    deferAppUpdate: () => ipcRenderer.invoke("app:deferAppUpdate"),
    checkCoreUpdate: () => ipcRenderer.invoke("app:checkCoreUpdate"),
    relaunch: () => ipcRenderer.invoke("app:relaunch"),
    editAction: (action: "copy" | "cut" | "paste" | "delete" | "selectAll") => ipcRenderer.invoke("app:editAction", action),
  },
  plugins: {
    getPackages: () => ipcRenderer.invoke("plugins:getPackages"),
    setPackageEnabled: (source: string, enabled: boolean) => ipcRenderer.invoke("plugins:setPackageEnabled", { source, enabled }),
    installPackage: (source: string) => ipcRenderer.invoke("plugins:installPackage", source),
    removePackage: (source: string) => ipcRenderer.invoke("plugins:removePackage", source),
    getSkills: (cwd?: string) => ipcRenderer.invoke("plugins:getSkills", cwd),
    setSkillEnabled: (path: string, enabled: boolean) => ipcRenderer.invoke("plugins:setSkillEnabled", { path, enabled }),
    updatePackages: (source?: string) => ipcRenderer.invoke("plugins:updatePackages", source),
  },
  automation: {
    getTasks: () => ipcRenderer.invoke("automation:getTasks"),
    saveTask: (task: unknown) => ipcRenderer.invoke("automation:saveTask", task),
    deleteTask: (id: string) => ipcRenderer.invoke("automation:deleteTask", id),
    runNow: (id: string) => ipcRenderer.invoke("automation:runNow", id),
  },
  git: {
    status: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
    branches: (cwd: string) => ipcRenderer.invoke("git:branches", cwd),
    log: (cwd: string, limit?: number) => ipcRenderer.invoke("git:log", cwd, limit),
    stage: (args: { cwd: string; paths: string[] }) => ipcRenderer.invoke("git:stage", args),
    unstage: (args: { cwd: string; paths: string[] }) => ipcRenderer.invoke("git:unstage", args),
    stageAll: (cwd: string) => ipcRenderer.invoke("git:stageAll", cwd),
    unstageAll: (cwd: string) => ipcRenderer.invoke("git:unstageAll", cwd),
    discard: (args: { cwd: string; tracked: string[]; untracked: string[] }) => ipcRenderer.invoke("git:discard", args),
    commit: (args: { cwd: string; message: string }) => ipcRenderer.invoke("git:commit", args),
    generateMessage: (cwd: string) => ipcRenderer.invoke("git:generateMessage", cwd),
    checkout: (args: { cwd: string; branch: string }) => ipcRenderer.invoke("git:checkout", args),
    pull: (cwd: string) => ipcRenderer.invoke("git:pull", cwd),
    push: (cwd: string) => ipcRenderer.invoke("git:push", cwd),
  },
  mcp: {
    getServers: () => ipcRenderer.invoke("mcp:getServers"),
    probeServers: () => ipcRenderer.invoke("mcp:probeServers"),
    saveServer: (name: string, config: Record<string, unknown>) => ipcRenderer.invoke("mcp:saveServer", { name, config }),
    removeServer: (name: string) => ipcRenderer.invoke("mcp:removeServer", name),
    setServerEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke("mcp:setServerEnabled", { name, enabled }),
    setLists: (disabledServers: string[], enabledServers: string[]) => ipcRenderer.invoke("mcp:setLists", { disabledServers, enabledServers }),
  },
  thread: {
    open: (args: { cwd: string; sessionFile?: string; name?: string; permission?: "sandbox" | "full" }) => ipcRenderer.invoke("thread:open", args),
    loadHistory: (args: { cwd: string; sessionFile: string }) => ipcRenderer.invoke("thread:loadHistory", args),
    close: (threadId: string) => ipcRenderer.invoke("thread:close", threadId),
    prompt: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:prompt", args),
    steer: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:steer", args),
    followUp: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:followUp", args),
    abort: (threadId: string) => ipcRenderer.invoke("thread:abort", threadId),
    setModel: (args: { threadId: string; provider: string; modelId: string }) => ipcRenderer.invoke("thread:setModel", args),
    getModels: (threadId: string) => ipcRenderer.invoke("thread:getModels", threadId),
    refreshModels: (threadId: string) => ipcRenderer.invoke("thread:refreshModels", threadId),
    setThinking: (args: { threadId: string; level: string }) => ipcRenderer.invoke("thread:setThinking", args),
    getThinkingLevels: (threadId: string) => ipcRenderer.invoke("thread:getThinkingLevels", threadId),
    newSession: (threadId: string) => ipcRenderer.invoke("thread:newSession", threadId),
    getBranchMessages: (threadId: string) => ipcRenderer.invoke("thread:getBranchMessages", threadId),
    fork: (args: { threadId: string; entryId: string }) => ipcRenderer.invoke("thread:fork", args),
    clone: (args: { threadId: string; entryId: string }) => ipcRenderer.invoke("thread:clone", args),
    setName: (args: { threadId: string; name: string }) => ipcRenderer.invoke("thread:setName", args),
    getStats: (threadId: string) => ipcRenderer.invoke("thread:getStats", threadId),
    getCommands: (threadId: string) => ipcRenderer.invoke("thread:getCommands", threadId),
    extuiResponse: (args: { threadId: string; id: string; payload: Record<string, unknown> }) =>
      ipcRenderer.invoke("thread:extuiResponse", args),
    setPermission: (args: { threadId: string; permission: "sandbox" | "full" }) => ipcRenderer.invoke("thread:setPermission", args),
  },
  settings: {
    getModels: () => ipcRenderer.invoke("settings:getModels"),
    testModel: (args: { providerId: string; provider: Record<string, unknown>; modelId: string }) =>
      ipcRenderer.invoke("settings:testModel", args),
    saveModels: (providers: Record<string, unknown>) => ipcRenderer.invoke("settings:saveModels", providers),
    getThinking: () => ipcRenderer.invoke("settings:getThinking"),
    saveThinking: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:saveThinking", patch),
    getDefaultRole: () => ipcRenderer.invoke("settings:getDefaultRole"),
    setDefaultRole: (provider: string, model: string | null) => ipcRenderer.invoke("settings:setDefaultRole", provider, model),
    getDiagnostics: () => ipcRenderer.invoke("settings:getDiagnostics"),
    getPaths: () => ipcRenderer.invoke("settings:getPaths"),
    openPath: (abs: string) => ipcRenderer.invoke("settings:openPath", abs),
    showItem: (abs: string) => ipcRenderer.invoke("settings:showItem", abs),
    openAgentDir: () => ipcRenderer.invoke("settings:openAgentDir"),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizedChanged: (cb: (max: boolean) => void) => on("window:maximized-changed", cb),
  },
  on: {
    event: (cb: (p: { threadId: string; event: any }) => void) => on("pi:event", cb),
    extui: (cb: (p: { threadId: string; request: any }) => void) => on("pi:extui", cb),
    exit: (cb: (p: { threadId: string; code: number | null; signal: string | null; stderr: string }) => void) => on("pi:exit", cb),
    error: (cb: (p: { threadId: string; message: string }) => void) => on("pi:error", cb),
    automation: (cb: (p: { type: "start" | "done"; taskId: string; name: string; ok?: boolean; error?: string }) => void) =>
      on("pi:automation", cb),
    appUpdate: (cb: (p: { stage: string; message: string; pct?: number; version?: string }) => void) => on("pi:appUpdate", cb),
    coreUpdate: (cb: (p: { stage: string; message: string; pct?: number }) => void) => on("pi:coreUpdate", cb),
    notifyActivate: (cb: (p: { threadId: string; cwd?: string }) => void) => on("pi:notify-activate", cb),
  },
};

contextBridge.exposeInMainWorld("pi", api);

export type PiApi = typeof api;
