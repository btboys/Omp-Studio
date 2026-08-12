import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { modelShort } from "../lib/format";
import { reasoningLevelLabel } from "../lib/reasoning";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { EnhancePromptResult, FileNode, ModelInfo, PendingFile, PendingImage, ProviderUsageReport } from "../lib/types";
import { Plus, Paperclip, ImageIcon, Send, Stop, Smile, At, Shield, Edit, Zap, Folder, Search, Check, ChevronRight, Branch, MagicWand, Sparkle, Clipboard } from "./icons";
import { ProviderUsageInline, parseProviderUsage } from "./ProviderUsage";

let _pid = 0;
const pid = () => `p${_pid++}`;

/**
 * Session mode selector (Build / Plan / Vibe / Goal) — entry hidden for now.
 * omp's pi-RPC protocol has no plan/vibe/goal mode activation yet
 * (https://github.com/can1357/oh-my-pi/issues/8171), so only "Plan" (plan-role
 * model routing) would do anything. The store wiring (setPlanMode,
 * threadPlanModes persistence, restore-on-open) and the dropdown JSX below are
 * kept intact; flip this to true once the runtime exposes set_mode.
 */
const MODE_SELECTOR_ENABLED = false;


/** Detect an in-progress `@file` token just before the caret. */
function detectAtMention(text: string, caret: number): { start: number; query: string } | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, safeCaret);
  const match = before.match(/(^|[\s])@([^\s]*)$/);
  if (!match) return null;
  const query = match[2] || "";
  const start = before.length - query.length - 1;
  return { start, query };
}

function fileToImage(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.split(",")[1] || "";
      resolve({ id: pid(), dataUrl, base64, mimeType: file.type });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function Composer({ threadId }: { threadId: string }) {
  // Select only what the composer renders, as primitives / stable references.
  // Subscribing to the whole thread object made every streaming token
  // re-render the entire composer (textarea included).
  const isStreaming = useStore((s) => !!s.threads[threadId]?.isStreaming);
  const pending = useStore((s) => s.threads[threadId]?.pendingFollowUp || null);
  const injected = useStore((s) => s.threads[threadId]?.pendingEditorText);
  const permission = useStore((s) => s.threads[threadId]?.permission);
  const advisory = useStore((s) => s.threads[threadId]?.advisory ?? false);
  const language = useStore((s) => s.config?.language || "en");
  const commands = useStore((s) => s.threads[threadId]?.commands);
  const models = useStore((s) => s.threads[threadId]?.models);
  const levels = useStore((s) => s.threads[threadId]?.levels);
  const model = useStore((s) => s.threads[threadId]?.model);
  const thinking = useStore((s) => s.threads[threadId]?.thinking);
  const cwd = useStore((s) => s.threads[threadId]?.cwd || "");
  const isDraftTask = useStore(
    (s) => !s.threads[threadId]?.messages.some((message) => message.role === "user" || message.role === "assistant"),
  );
  const projects = useStore((s) => s.projects);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abortThread = useStore((s) => s.abortThread);
  const setModel = useStore((s) => s.setModel);
  const setThinking = useStore((s) => s.setThinking);
  const setPermission = useStore((s) => s.setPermission);
  const setAdvisor = useStore((s) => s.setAdvisor);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const planMode = useStore((s) => !!s.threads[threadId]?.planMode);
  const setPendingFollowUp = useStore((s) => s.setPendingFollowUp);
  const sendPendingSteering = useStore((s) => s.sendPendingSteering);
  const changeDraftThreadFolder = useStore((s) => s.changeDraftThreadFolder);

  // git branch of the thread cwd; refresh when folder changes or a run ends
  // (agent may have switched branches).
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd) {
      setGitBranch(null);
      return;
    }
    let alive = true;
    window.pi.app
      .getGitBranch(cwd)
      .then((branch) => {
        if (alive) setGitBranch(branch);
      })
      .catch(() => {
        if (alive) setGitBranch(null);
      });
    return () => {
      alive = false;
    };
  }, [cwd, isStreaming]);

  // Provider plan/balance strip inside the input card: fetch once the thread's
  // model provider is known (connect may lag the tab open).
  const [providerUsage, setProviderUsage] = useState<ProviderUsageReport | null>(null);
  const loadProviderUsage = async () => {
    try {
      const res = await window.pi.app.getProviderUsage();
      const reports = parseProviderUsage(res);
      const provider = useStore.getState().threads[threadId]?.model?.provider;
      setProviderUsage(provider ? (reports || []).find((r) => r.provider === provider) || null : null);
    } catch {
      setProviderUsage(null);
    }
  };
  useEffect(() => {
    if (!useStore.getState().threads[threadId]?.model?.provider) return;
    void loadProviderUsage();
  }, [threadId, model?.provider]);

  // Per-tab draft lives in the store: switching tabs no longer shares one
  // composer instance's local state (which made the text effectively global).
  const text = useStore((s) => s.drafts[threadId] ?? "");
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const setText = (v: string | ((prev: string) => string)) =>
    setComposerDraft(threadId, typeof v === "function" ? v(useStore.getState().drafts[threadId] ?? "") : v);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [cmdOpen, setCmdOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [permOpen, setPermOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [enhanceResult, setEnhanceResult] = useState<EnhancePromptResult | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const [atItems, setAtItems] = useState<FileNode[]>([]);
  const [atLoading, setAtLoading] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const permRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const cmdRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<HTMLDivElement>(null);
  const enhanceRef = useRef<HTMLDivElement>(null);

  // close popups on outside click / Escape
  useOutsideClose(permRef, permOpen, () => setPermOpen(false));
  useOutsideClose(modeRef, modeOpen, () => setModeOpen(false));
  useOutsideClose(cmdRef, cmdOpen, () => setCmdOpen(false));
  useOutsideClose(modelRef, modelOpen, () => setModelOpen(false));
  useOutsideClose(projectRef, projectOpen, () => setProjectOpen(false));
  useOutsideClose(enhanceRef, enhanceOpen, () => setEnhanceOpen(false));

  // extension-injected editor text
  const lastInjected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (injected && injected !== lastInjected.current) {
      lastInjected.current = injected;
      setText(injected);
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [injected]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  };
  useEffect(autoGrow, [text]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files;
    if (!dropped?.length) return;
    const imgs: PendingImage[] = [];
    const fs: PendingFile[] = [];
    for (const f of Array.from(dropped)) {
      if (f.type.startsWith("image/")) {
        const im = await fileToImage(f);
        if (im) imgs.push(im);
        continue;
      }
      const abs = window.pi.app.getPathForFile(f);
      if (abs) fs.push({ abs, name: f.name });
    }
    setImages((p) => [...p, ...imgs]);
    setFiles((p) => [...p, ...fs.filter((nf) => !p.some((x) => x.abs === nf.abs))]);
  };

  const addFiles = async () => {
    const paths = await window.pi.app.showOpenDialog("files");
    if (!paths || !Array.isArray(paths)) return;
    const names = paths.map((p) => p.split(/[\\/]/).pop() || p);
    setFiles((p) => [...p, ...paths.map((abs, i) => ({ abs, name: names[i] }))]);
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: PendingImage[] = [];
    const fs: PendingFile[] = [];
    for (const it of Array.from(items)) {
      if (it.kind !== "file") continue;
      const f = it.getAsFile();
      if (!f) continue;
      if (f.type.startsWith("image/")) {
        const im = await fileToImage(f);
        if (im) imgs.push(im);
        continue;
      }
      // Pasted files carry no absolute path in the renderer (File.path was
      // removed in Electron 32); resolve the real path via webUtils in preload.
      const abs = window.pi.app.getPathForFile(f);
      if (abs) fs.push({ abs, name: f.name });
    }
    if (imgs.length || fs.length) {
      e.preventDefault();
      setImages((p) => [...p, ...imgs]);
      setFiles((p) => [...p, ...fs.filter((nf) => !p.some((x) => x.abs === nf.abs))]);
    }
  };

  const dispatchSend = async (t: string, mode?: "steer" | "followUp") => {
    const imgs = images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
    const atts = files.map((f) => ({ abs: f.abs, name: f.name }));
    setText("");
    setImages([]);
    setFiles([]);
    setEnhanceOpen(false);
    setEnhanceResult(null);
    await sendPrompt(threadId, t, imgs.length ? imgs : undefined, atts.length ? atts : undefined, mode);
  };

  const send = async (mode?: "steer" | "followUp") => {
    const t = text.trim();
    if (!t && !images.length && !files.length) return;
    await dispatchSend(t, mode);
  };

  // Project-aware prompt restructure (composer wand). Never blocks sending:
  // on failure the user keeps the original text.
  const runEnhance = async () => {
    const t = text.trim();
    if (!t) {
      useStore.getState().pushToast("warning", "先输入要优化的提示词");
      return;
    }
    if (enhanceBusy) return;
    setEnhanceBusy(true);
    try {
      const res = await window.pi.app.enhancePrompt(cwd, t);
      if (res) {
        setEnhanceResult(res);
        setEnhanceOpen(true);
      } else {
        useStore.getState().pushToast("warning", "提示词优化不可用（未找到可用的模型凭证），已保留原文");
      }
    } catch (e: any) {
      useStore.getState().pushToast("error", "提示词优化失败：" + (e?.message || e));
    } finally {
      setEnhanceBusy(false);
    }
  };

  // Send the reviewed optimized prompt, honouring the streaming rules the
  // plain send path applies (Enter during streaming stages a follow-up).
  const sendEnhanced = () => {
    if (!enhanceResult) return;
    const t = enhanceResult.prompt.trim();
    if (!t) return;
    if (isStreaming) {
      if (pending) {
        void dispatchSend(t, "followUp");
      } else {
        setPendingFollowUp(threadId, { text: t, images, files });
        setText("");
        setImages([]);
        setFiles([]);
        setEnhanceOpen(false);
        setEnhanceResult(null);
      }
      return;
    }
    void dispatchSend(t);
  };

  // While streaming, Enter stages the message as a pending follow-up card
  // instead of sending it. It is delivered when the agent settles, unless the
  // user re-edits it or promotes it to steering first.
  const queuePending = () => {
    const t = text.trim();
    if (!t && !images.length && !files.length) return;
    if (pending) {
      // A follow-up is already staged; queue this one straight into pi.
      const imgs = images.map((im) => ({ data: im.base64, mimeType: im.mimeType }));
      const atts = files.map((f) => ({ abs: f.abs, name: f.name }));
      setText("");
      setImages([]);
      setFiles([]);
      sendPrompt(threadId, t, imgs.length ? imgs : undefined, atts.length ? atts : undefined, "followUp");
      return;
    }
    setPendingFollowUp(threadId, { text: t, images, files });
    setText("");
    setImages([]);
    setFiles([]);
  };

  const reEditPending = () => {
    if (!pending) return;
    setText(pending.text);
    setImages(pending.images);
    setFiles(pending.files);
    setPendingFollowUp(threadId, null);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoGrow();
    });
  };

  const syncCaret = () => {
    const next = taRef.current?.selectionStart ?? caret;
    if (next !== caret) setCaret(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME (中文/日文/韩文等) 确认候选时也会触发 Enter；此时不要发送或抢占方向键。
    // keyCode 229 是部分环境在合成阶段/确认瞬间的兼容回退。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (atMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIndex((index) => (index + 1) % Math.max(atItems.length, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIndex((index) => (index - 1 + Math.max(atItems.length, 1)) % Math.max(atItems.length, 1));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && atItems.length > 0) {
        e.preventDefault();
        chooseAtFile(atItems[atIndex] || atItems[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtDismissed(true);
        return;
      }
    }

    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && slashItems.length > 0) {
        e.preventDefault();
        chooseSlashCommand(slashItems[slashIndex] || slashItems[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Prompt enhancement is running; don't let Enter send or stage meanwhile.
      if (enhanceBusy) return;
      if (isStreaming) {
        // Alt+Enter interrupts now (steering); Enter stages a pending follow-up.
        if (e.altKey) send("steer");
        else queuePending();
      } else {
        send();
      }
    }
  };

  const modelList = models || [];
  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ModelInfo[]>();
    for (const item of modelList) {
      const providerModels = grouped.get(item.provider) || [];
      providerModels.push(item);
      grouped.set(item.provider, providerModels);
    }
    return Array.from(grouped, ([provider, providerModels]) => ({ provider, models: providerModels }));
  }, [modelList]);
  const levelList = (levels || []).filter((l) => l !== "off");
  const thinkLabel = thinking === "off" ? "" : reasoningLevelLabel(thinking, language);
  const mappedThinkingLevel = (level: string) => {
    const mapped = model?.thinkingLevelMap?.[level];
    return mapped && mapped !== level ? mapped : null;
  };
  const projectName = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd || "No project";
  const visibleProjects = projects.filter((project) => {
    const query = projectQuery.trim().toLowerCase();
    return !query || project.name.toLowerCase().includes(query) || project.cwd.toLowerCase().includes(query);
  });
  const slashMatch = text.match(/^\/([^\s]*)$/);
  const slashQuery = (slashMatch?.[1] || "").toLowerCase();
  const slashItems = useMemo(
    () =>
      (commands || [])
        .filter((command: any) => {
          const displayName = command.source === "skill" ? String(command.name).replace(/^skill:/, "") : String(command.name);
          return (
            !slashQuery ||
            displayName.toLowerCase().includes(slashQuery) ||
            (command.source !== "skill" && String(command.description || "").toLowerCase().includes(slashQuery))
          );
        })
        .slice(0, 30),
    [commands, slashQuery],
  );
  const commandItems = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    return (commands || [])
      .filter((command: any) => {
        const rawName = String(command.name || "");
        const displayName = command.source === "skill" ? rawName.replace(/^skill:/, "") : rawName;
        const haystack = [rawName, displayName, String(command.description || ""), String(command.source || "")]
          .join(" ")
          .toLowerCase();
        return !query || haystack.includes(query);
      })
      .slice(0, 50);
  }, [commands, commandQuery]);
  const slashMenuOpen = !!slashMatch && !slashDismissed && slashItems.length > 0;
  const atMention = !slashMenuOpen ? detectAtMention(text, caret) : null;
  const atQuery = atMention?.query || "";
  const atMenuOpen = !!atMention && !atDismissed && !!cwd;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setAtIndex(0);
  }, [atQuery, cwd]);

  useEffect(() => {
    if (!atMention || !cwd) {
      setAtItems([]);
      setAtLoading(false);
      return;
    }
    let cancelled = false;
    setAtLoading(true);
    const timer = window.setTimeout(() => {
      void window.pi.app
        .searchProjectFiles(cwd, atQuery, 30)
        .then((nodes) => {
          if (cancelled) return;
          setAtItems(Array.isArray(nodes) ? nodes : []);
          setAtLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setAtItems([]);
          setAtLoading(false);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [atMention?.start, atQuery, cwd, text]);

  const chooseSlashCommand = (command: any) => {
    setText(`/${command.name} `);
    setSlashDismissed(true);
    setAtDismissed(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const chooseAtFile = (file: FileNode) => {
    const mention = detectAtMention(text, caret);
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(caret);
    // Code files become a path-only reference: no attachment (that would
    // inline the content via processAttachments) and no `@` token (omp
    // auto-reads `@path` mentions server-side into the prompt). The agent
    // reads the file itself with its own tools. Folders keep the native
    // `@folder/` mention so the runtime lists the directory.
    const inserted = file.isDir ? `@${file.rel}/ ` : `\`${file.rel}\` `;
    const next = before + inserted + after;
    setText(next);
    setAtDismissed(true);
    setAtItems([]);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const pos = before.length + inserted.length;
      ta.setSelectionRange(pos, pos);
      setCaret(pos);
      autoGrow();
    });
  };

  const toggleCommands = () => {
    setCmdOpen((open) => {
      if (open) setCommandQuery("");
      return !open;
    });
  };

  const chooseProject = async (nextCwd: string) => {
    setProjectOpen(false);
    setProjectQuery("");
    await changeDraftThreadFolder(threadId, nextCwd);
  };

  const chooseNewProject = async () => {
    const path = await window.pi.app.showOpenDialog("folder");
    if (!path || Array.isArray(path)) return;
    await chooseProject(path);
  };

  return (
    <div className="composer-wrap" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="composer">
        {/* Always render: the enhance (优化提示词) wand must stay reachable even
            when the thread is not a draft and the folder has no git branch
            (non-git repo / unborn branch / git error → gitBranch is null). */}
        <div className="composer-project-row" ref={projectRef}>
            {isDraftTask && !isStreaming && (
              <button
                className={`composer-project-pill ${projectOpen ? "open" : ""}`}
                onClick={() => setProjectOpen((value) => !value)}
                title={cwd}
                aria-haspopup="menu"
                aria-expanded={projectOpen}
              >
                <Folder size={14} />
                <span>{projectName}</span>
                <ChevronRight className="project-pill-caret" size={12} />
              </button>
            )}
            {projectOpen && (
              <div className="composer-project-menu" role="menu">
                <label className="project-menu-search">
                  <Search size={15} />
                  <input
                    autoFocus
                    value={projectQuery}
                    onChange={(event) => setProjectQuery(event.target.value)}
                    placeholder="搜索项目"
                  />
                </label>
                <div className="project-menu-list">
                  {visibleProjects.map((project) => {
                    const active = project.cwd.toLowerCase() === cwd.toLowerCase();
                    return (
                      <button
                        key={project.cwd}
                        className={`project-menu-option ${active ? "active" : ""}`}
                        onClick={() => chooseProject(project.cwd)}
                        role="menuitemradio"
                        aria-checked={active}
                        title={project.cwd}
                      >
                        <Folder size={16} />
                        <span>{project.name}</span>
                        {active && <Check className="project-menu-check" size={16} />}
                      </button>
                    );
                  })}
                  {visibleProjects.length === 0 && <div className="project-menu-empty">没有匹配的项目</div>}
                </div>
                <div className="project-menu-divider" />
                <button className="project-menu-new" onClick={chooseNewProject}>
                  <Plus size={16} />
                  <span>新建项目</span>
                </button>
              </div>
            )}
            {gitBranch && (
              <span className="composer-branch-pill" title={`当前 Git 分支：${gitBranch}`}>
                <Branch size={13} />
                <span className="composer-branch-name">{gitBranch}</span>
              </span>
            )}
            <div className="pill composer-enhance" ref={enhanceRef}>
              <button
                className="iconbtn"
                title="优化提示词：结合项目上下文重写为结构化表达（可预览后再发送）"
                onClick={() => {
                  setProjectOpen(false);
                  enhanceOpen ? setEnhanceOpen(false) : void runEnhance();
                }}
                disabled={enhanceBusy}
              >
                {enhanceBusy ? <span className="spinner" /> : <MagicWand size={16} />}
              </button>
              {enhanceOpen && enhanceResult && (
                <div className="pill-pop enhance-pop">
                  <div className="enhance-pop-head">
                    <span>优化后的提示词</span>
                    {enhanceResult.contextUsed && (
                      <span className="enhance-pop-hint">基于：{enhanceResult.contextUsed}</span>
                    )}
                  </div>
                  <textarea
                    autoFocus
                    value={enhanceResult.prompt}
                    onChange={(e) => setEnhanceResult({ ...enhanceResult, prompt: e.target.value })}
                    placeholder="优化后的提示词"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEnhanceOpen(false);
                      } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        sendEnhanced();
                      }
                    }}
                  />
                  <div className="enhance-pop-actions">
                    <button className="set-btn ghost" onClick={() => setEnhanceOpen(false)}>
                      取消
                    </button>
                    <button className="set-btn" onClick={sendEnhanced} disabled={!enhanceResult.prompt.trim()}>
                      发送优化版
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        {slashMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label="Slash commands">
            <div className="slash-menu-head">Commands, plugins &amp; skills</div>
            <div className="slash-menu-list">
              {slashItems.map((command: any, index: number) => {
                const isSkill = command.source === "skill";
                const displayName = isSkill ? String(command.name).replace(/^skill:/, "") : command.name;
                const kind = isSkill ? "Skill" : command.source === "extension" ? "Plugin" : "Prompt";
                return (
                  <button
                    key={`${command.source || "command"}:${command.name}`}
                    className={`slash-menu-item ${index === slashIndex ? "active" : ""}`}
                    role="option"
                    aria-selected={index === slashIndex}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSlashCommand(command)}
                  >
                    <span className="slash-command-name">{displayName}</span>
                    <span className={`slash-command-kind ${command.source || "command"}`}>{kind}</span>
                    {!isSkill && command.description && (
                      <span className="slash-command-description">{command.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {atMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label="Project files">
            <div className="slash-menu-head">Project files</div>
            <div className="slash-menu-list">
              {atLoading && atItems.length === 0 && <div className="project-menu-empty">搜索中…</div>}
              {!atLoading && atItems.length === 0 && <div className="project-menu-empty">没有匹配的文件或文件夹</div>}
              {atItems.map((file, index) => (
                <button
                  key={file.abs}
                  className={`slash-menu-item ${index === atIndex ? "active" : ""}`}
                  role="option"
                  aria-selected={index === atIndex}
                  onMouseEnter={() => setAtIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseAtFile(file)}
                  title={file.abs}
                >
                  <span className="slash-command-name">
                    {file.isDir && <Folder size={12} style={{ verticalAlign: "-1.5px", marginRight: 4 }} />}
                    {file.name}
                  </span>
                  <span className={`slash-command-kind ${file.isDir ? "dir" : "command"}`}>{file.isDir ? "Dir" : "File"}</span>
                  <span className="slash-command-description">
                    {file.rel}
                    {file.isDir ? "/" : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {(images.length > 0 || files.length > 0) && (
          <div className="composer-attachments">
            {images.map((im) => (
              <div key={im.id} className="attach-chip">
                <img src={im.dataUrl} alt="" />
                <span className="nm">image</span>
                <button className="rm" onClick={() => setImages((p) => p.filter((x) => x.id !== im.id))}>
                  ×
                </button>
              </div>
            ))}
            {files.map((f) => (
              <div key={f.abs} className="attach-chip">
                <span>📎</span>
                <span className="nm" title={f.abs}>
                  {f.name}
                </span>
                <button className="rm" onClick={() => setFiles((p) => p.filter((x) => x.abs !== f.abs))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {pending && (
          <div className="pending-fu">
            <div className="pf-main">
              <div className="pf-label">
                <span className="pf-dot" />
                待处理 follow-up
                <span className="pf-sub">· 当前任务完成后自动发送</span>
              </div>
              <div className="pf-text">{pending.text || `${pending.images.length + pending.files.length} 个附件`}</div>
            </div>
            <div className="pf-actions">
              <button className="pf-btn" title="重新编辑" onClick={reEditPending}>
                <Edit size={14} />
              </button>
              <button className="pf-btn steer" title="立即 steering（尽快插入上下文执行）" onClick={() => sendPendingSteering(threadId)}>
                <Zap size={14} />
              </button>
            </div>
          </div>
        )}

        <div className="composer-input">
          <textarea
            ref={taRef}
            rows={1}
            placeholder={isStreaming ? "输入插话… Enter 存为待处理 follow-up（完成后发送），Alt+Enter 立即 steering（中断当前）" : "随心输入  ·  @ 引用项目文件  ·  / 命令  ·  + 添加文件  ·  ✦ 优化提示词"}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setSlashDismissed(false);
              setAtDismissed(false);
            }}
            onSelect={syncCaret}
            onClick={syncCaret}
            onKeyUp={syncCaret}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>

        <div className="composer-bar">
          <div className="cb-left">
            <button className="iconbtn" title="Add files" onClick={addFiles}>
              <Plus size={17} />
            </button>
            <div className="pill perm-pill composer-optional-action" ref={permRef}>
              <button
                className={`pill-btn perm-btn ${permission === "full" ? "perm-full" : permission === "auto" ? "perm-auto" : ""}`}
                title="权限级别：sandbox 仅自动放行明确只读的 shell 命令，并限制项目外写入；自动审批放行常规操作、危险操作仍需确认；完全权限为 omp 默认 unrestricted 模式"
                onClick={() => setPermOpen((v) => !v)}
              >
                <Shield size={13} /> {permission === "full" ? "完全权限" : permission === "auto" ? "自动审批" : "sandbox"} ▾
              </button>
              {permOpen && (
                <div className="pill-pop perm-pop">
                  <button
                    className={`opt ${permission === "sandbox" ? "active" : ""}`}
                    onClick={() => {
                      setPermOpen(false);
                      setPermission(threadId, "sandbox");
                    }}
                  >
                    <span className="o1">sandbox</span>
                    <span className="o2">敏感命令执行前需确认（默认）</span>
                  </button>
                  <button
                    className={`opt ${permission === "auto" ? "active" : ""}`}
                    onClick={() => {
                      setPermOpen(false);
                      setPermission(threadId, "auto");
                    }}
                  >
                    <span className="o1">自动审批</span>
                    <span className="o2">替我审批：常规操作自动放行，危险操作仍需确认</span>
                  </button>
                  <button
                    className={`opt ${permission === "full" ? "active" : ""}`}
                    onClick={() => {
                      setPermOpen(false);
                      setPermission(threadId, "full");
                    }}
                  >
                    <span className="o1">完全权限</span>
                    <span className="o2">omp 默认，不拦截任何操作</span>
                  </button>
                </div>
              )}
            </div>
            <div className="pill composer-optional-action">
              <button
                className={`pill-btn advisory-btn ${advisory ? "advisory-on" : ""}`}
                title={
                  language === "zh"
                    ? "会话级 advisory 开关：开启后 omp advisor 会把建议注入对话；关闭后不再注入"
                    : "Session-level advisory toggle: when on, omp's advisor injects advisory notes into the conversation"
                }
                onClick={() => setAdvisor(threadId, !advisory)}
              >
                <Sparkle size={13} /> {language === "zh" ? (advisory ? "advisory 开" : "advisory 关") : advisory ? "advisory on" : "advisory off"}
              </button>
            </div>
            {MODE_SELECTOR_ENABLED && (
              <div className="pill composer-mode-pill composer-optional-action" ref={modeRef}>
                <button
                  className={`pill-btn mode-btn ${planMode ? "mode-on" : ""}`}
                  title={
                    language === "zh"
                      ? "会话模式（互斥）：正常 / 规划 / vibe / goal"
                      : "Session mode (mutually exclusive): build / plan / vibe / goal"
                  }
                  onClick={() => setModeOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={modeOpen}
                >
                  <Clipboard size={13} />
                  {language === "zh" ? (planMode ? "规划" : "正常") : planMode ? "Plan" : "Build"}
                  <span className="pill-caret">▾</span>
                </button>
                {modeOpen && (
                  <div className="pill-pop mode-pop">
                    <button
                      className={`opt ${!planMode ? "active" : ""}`}
                      onClick={() => {
                        setModeOpen(false);
                        if (planMode) void setPlanMode(threadId, false);
                      }}
                    >
                      <span className="o1">{language === "zh" ? "正常模式" : "Build"}</span>
                      <span className="o2">{language === "zh" ? "默认工作模式，不启用特殊模式" : "Default mode, no special workflow"}</span>
                    </button>
                    <button
                      className={`opt ${planMode ? "active" : ""}`}
                      onClick={() => {
                        setModeOpen(false);
                        if (!planMode) void setPlanMode(threadId, true);
                      }}
                    >
                      <span className="o1">{language === "zh" ? "规划模式" : "Plan"}</span>
                      <span className="o2">{language === "zh" ? "先计划后执行：切换到 plan 角色模型（设置 → 模型角色）" : "Plan-then-execute: switches to the plan-role model (Settings → model roles)"}</span>
                    </button>
                    <button
                      className="opt"
                      onClick={() => {
                        setModeOpen(false);
                        useStore
                          .getState()
                          .pushToast(
                            "warning",
                            language === "zh"
                              ? "vibe 模式暂无法在应用中启用：omp 当前版本的 RPC 未开放模式激活（仅 TUI/ACP 可用）" + (planMode ? "；需先退出规划模式。" : "。")
                              : "Vibe mode can't be enabled from the app yet: this omp version's RPC doesn't expose mode activation (TUI/ACP only)" + (planMode ? "; exit plan mode first." : "."),
                          );
                      }}
                    >
                      <span className="o1">Vibe</span>
                      <span className="o2">{language === "zh" ? "导演调度 worker 会话（当前 RPC 未开放）" : "Director-style worker sessions (RPC not exposed yet)"}</span>
                    </button>
                    <button
                      className="opt"
                      onClick={() => {
                        setModeOpen(false);
                        useStore
                          .getState()
                          .pushToast(
                            "warning",
                            language === "zh"
                              ? "goal 模式暂无法在应用中启用：omp 当前版本的 RPC 未开放模式激活（仅 TUI/ACP 可用）" + (planMode ? "；需先退出规划模式。" : "。")
                              : "Goal mode can't be enabled from the app yet: this omp version's RPC doesn't expose mode activation (TUI/ACP only)" + (planMode ? "; exit plan mode first." : "."),
                          );
                      }}
                    >
                      <span className="o1">Goal</span>
                      <span className="o2">{language === "zh" ? "持续自主推进目标（当前 RPC 未开放）" : "Autonomous goal pursuit (RPC not exposed yet)"}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="pill composer-optional-action" ref={cmdRef}>
              <button className="pill-btn" title="Slash commands / skills" onClick={toggleCommands}>
                <At size={14} /> 命令
              </button>
              {cmdOpen && (
                <div className="pill-pop command-pop">
                  <label className="command-search">
                    <Search size={13} />
                    <input
                      autoFocus
                      value={commandQuery}
                      onChange={(event) => setCommandQuery(event.target.value)}
                      placeholder="搜索命令、插件或 skill"
                      aria-label="搜索命令、插件或 skill"
                    />
                  </label>
                  <div className="command-list">
                    {(commands || []).length === 0 && <div className="ft-empty">无可用命令</div>}
                    {(commands || []).length > 0 && commandItems.length === 0 && <div className="ft-empty">没有匹配的命令</div>}
                    {commandItems.map((c: any) => (
                      <button
                        key={`${c.source || "command"}:${c.name}`}
                        className="opt"
                        onClick={() => {
                          setText((t) => (t ? t + " " : "") + `/${c.name} `);
                          setCommandQuery("");
                          setCmdOpen(false);
                          taRef.current?.focus();
                        }}
                      >
                        <span className="o1">{c.source === "skill" ? String(c.name).replace(/^skill:/, "") : c.name}</span>
                        {c.source !== "skill" && c.description && <span className="o2">{c.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="cb-right">
            <div className="pill composer-model-pill" ref={modelRef}>
              <button className="pill-btn" onClick={() => setModelOpen((v) => !v)} title="模型与思考等级">
                {modelShort(model)}
                {thinkLabel && <span className="pill-think-tag">{thinkLabel}</span>}
                <span className="pill-caret">▾</span>
              </button>
              {modelOpen && (
                <div className="pill-pop model-pop">
                  <div className="pop-head">模型</div>
                  {modelList.length === 0 && <div className="ft-empty">无可用模型（检查 auth）</div>}
                  {modelGroups.map((group) => {
                    const expanded = expandedProviders[group.provider] === true;
                    const active = model?.provider === group.provider;
                    return (
                      <div className={`model-provider-group ${expanded ? "expanded" : ""}`} key={group.provider}>
                        <button
                          type="button"
                          className={`model-provider-toggle ${active ? "active" : ""}`}
                          onClick={() =>
                            setExpandedProviders((current) => ({
                              ...current,
                              [group.provider]: !expanded,
                            }))
                          }
                          aria-expanded={expanded}
                        >
                          <ChevronRight className="model-provider-chevron" size={13} />
                          <span className="model-provider-name">{group.provider}</span>
                          <span className="model-provider-count">{group.models.length}</span>
                        </button>
                        {expanded && (
                          <div className="model-provider-models">
                            {group.models.map((m) => (
                              <button
                                type="button"
                                key={`${m.provider}/${m.id}`}
                                className={`opt ${model?.id === m.id && model?.provider === m.provider ? "active" : ""}`}
                                onClick={() => setModel(threadId, m.provider, m.id)}
                              >
                                <span className="o1">{m.name || m.id}</span>
                                <span className="o2">{m.id}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {levelList.length > 0 && (
                    <>
                      <div className="pop-divider" />
                      <div className="pop-head">思考等级</div>
                      <div className="think-chips">
                        {(["off", ...levelList] as string[]).map((l) => {
                          const mapped = mappedThinkingLevel(l);
                          return (
                            <button
                              key={l}
                              className={`think-chip ${thinking === l ? "active" : ""}`}
                              onClick={() => {
                                setThinking(threadId, l);
                                setModelOpen(false);
                              }}
                            >
                              <span>{reasoningLevelLabel(l, language)}</span>
                              {mapped && <span className="think-chip-map">→ {mapped}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {isStreaming ? (
              <>
                <button
                  className="send-btn"
                  title="存为待处理 follow-up（Enter）；Alt+Enter 立即 steering"
                  onClick={() => queuePending()}
                  disabled={(enhanceBusy || (!text.trim() && !images.length && !files.length))}
                >
                  <Send size={15} />
                </button>
                <button className="send-btn stop" title="Stop" onClick={() => abortThread(threadId)}>
                  <Stop size={14} />
                </button>
              </>
            ) : (
              <button className="send-btn" title="Send" onClick={() => send()} disabled={enhanceBusy || (!text.trim() && !images.length && !files.length)}>
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
        {providerUsage && <ProviderUsageInline report={providerUsage} onRefresh={() => void loadProviderUsage()} />}
      </div>
    </div>
  );
}
