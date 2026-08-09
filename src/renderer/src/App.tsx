import { useEffect, useState } from "react";
import { useStore } from "./store";
import { usePiEvents } from "./lib/usePiEvents";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Preview } from "./components/Preview";
import { Toasts } from "./components/Toasts";
import { ExtUiModal } from "./components/ExtUiModal";
import { Settings } from "./components/Settings";
import { SearchModal } from "./components/SearchModal";
import { PluginsPanel } from "./components/PluginsPanel";
import { McpPanel } from "./components/McpPanel";
import { AutomationPanel } from "./components/AutomationPanel";
import { AppUpdateModal } from "./components/AppUpdateModal";
import { Folder, Plus } from "./components/icons";
import { LanguageBridge } from "./components/LanguageBridge";
import appIconUrl from "../../../resources/icon.png";

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const previewOpen = useStore((s) => s.previewOpen);
  const previewExpanded = useStore((s) => s.previewExpanded);
  const projects = useStore((s) => s.projects);
  const runtime = useStore((s) => s.runtime);
  const theme = useStore((s) => s.config?.theme || "light");
  const bootstrapped = useStore((s) => s.bootstrapped);
  usePiEvents();

  // Startup splash: bootstrap() loads config/projects/tabs over a few seconds;
  // without it the UI flashes the English default and empty state before
  // flipping to the saved language. Cover that window, then fade out.
  const [splashGone, setSplashGone] = useState(false);
  const [splashForced, setSplashForced] = useState(false);
  const splashZh = (navigator.language || "en").toLowerCase().startsWith("zh");
  useEffect(() => {
    if (!bootstrapped) return;
    const t = setTimeout(() => setSplashGone(true), 450); // match .splash transition
    return () => clearTimeout(t);
  }, [bootstrapped]);
  // Emergency escape if an IPC call hangs; don't lock the UI behind the splash forever.
  useEffect(() => {
    const t = setTimeout(() => setSplashForced(true), 20_000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // Test/automation seam for CDP verification (reorder/cycle without brittle DnD synthesis).
  useEffect(() => {
    (window as any).__ompStore = useStore;
    return () => {
      delete (window as any).__ompStore;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    if (theme !== "system") return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [theme]);

  // Ctrl/Cmd+K search; Ctrl/Cmd+W close tab; Ctrl/Cmd+Tab cycle tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.getState().openSearch();
        return;
      }

      if (e.key.toLowerCase() === "w") {
        const active = useStore.getState().activeThreadId;
        if (!active) return;
        e.preventDefault();
        void useStore.getState().requestCloseThread(active);
        return;
      }

      if (e.key === "Tab") {
        if (useStore.getState().openThreadIds.length < 2) return;
        e.preventDefault();
        useStore.getState().cycleOpenThread(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const newTask = async () => {
    let cwd: string | null = useStore.getState().activeProjectCwd;
    if (!cwd) {
      const p = await window.pi.app.showOpenDialog("folder");
      if (!p || Array.isArray(p)) return;
      await window.pi.app.openProject(p);
      await useStore.getState().refreshProjects();
      useStore.getState().setActiveProject(p);
      cwd = p;
    }
    if (cwd) await useStore.getState().openThread(cwd);
  };

  return (
    <div className="app">
      {!splashGone && (
        <div className={`splash${bootstrapped || splashForced ? " splash-leave" : ""}`}>
          <div className="splash-box">
            <div className="empty-state-app-icon">
              <img src={appIconUrl} alt="" aria-hidden="true" />
            </div>
            <h2>Omp Studio</h2>
            <div className="splash-row">
              <span className="spinner" />
              {splashZh ? "正在启动…" : "Starting…"}
            </div>
          </div>
        </div>
      )}
      <LanguageBridge />
      <TitleBar />
      <div className={`body ${previewExpanded ? "preview-expanded" : ""}`}>
        <Sidebar />
        {activeThreadId ? (
          <Chat />
        ) : (
          <section className="main">
            <div className="empty-state">
              <div>
                <div className="empty-state-app-icon">
                  <img src={appIconUrl} alt="" aria-hidden="true" />
                </div>
                <h2>Omp Studio</h2>
                <p style={{ maxWidth: 420, margin: "0 auto 16px" }}>
                  终端 omp 的 Windows 桌面端：完整继承模型、harness 与插件系统。左侧选择项目与会话，右侧预览文件。
                </p>
                {!runtime?.ok && runtime && <p style={{ color: "#b23a2c" }}>未检测到 omp：{runtime.error}</p>}
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button className="btn primary" onClick={newTask}>
                    <Plus size={14} /> 新建任务
                  </button>
                  <button className="btn" onClick={() => useStore.getState().openProjectFolder()}>
                    <Folder size={14} /> 打开项目文件夹
                  </button>
                </div>
                {projects.length === 0 && <p className="muted" style={{ marginTop: 14 }}>尚未打开任何项目。</p>}
              </div>
            </div>
          </section>
        )}
        {previewOpen && <Preview />}
      </div>
      <Toasts />
      <ExtUiModal />
      <SearchModal />
      <PluginsPanel />
      <McpPanel />
      <AutomationPanel />
      <AppUpdateModal />
      <Settings />
    </div>
  );
}
