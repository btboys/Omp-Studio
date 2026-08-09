import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, shell } from "electron";
import { startBackgroundAppUpdate } from "./app-updater";
import { loadConfig, getConfig, updateConfig } from "./config";
import { cleanupOldRuntimes } from "./core-updater";
import { registerHtmlPreviewProtocol, registerHtmlPreviewScheme } from "./html-preview-protocol";
import { registerIpc, stopAllBridges } from "./ipc";
import { mergeShellEnv } from "./shell-env";
import { ompBinaryFileName } from "./runtime-package";
import { stopAutomations, stopScheduler } from "./automation";

// GUI launches inherit launchd's sparse environment; pull in the user's
// login-shell env (API keys, PATH) before any omp process can spawn.
mergeShellEnv();

const APP_USER_MODEL_ID = "com.pi-studio.app";

// Establish the product identity before Electron creates any windows or jump
// list entries. Packaged builds also carry the matching executable metadata;
// development builds still run as electron.exe at the OS process level.
app.setName("Omp Studio");
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

// The rename "Pi Studio" -> "Omp Studio" also moved Electron's userData dir.
// On the first launch after the rename, carry the old directory over so
// config.json, the extracted omp runtime and the updater cache survive
// instead of being orphaned under the old app name.
if (!existsSync(app.getPath("userData"))) {
  const legacy = join(app.getPath("appData"), "Pi Studio");
  if (existsSync(legacy)) {
    try {
      renameSync(legacy, app.getPath("userData"));
    } catch {
      // The old app instance may still be running with files open; start fresh.
    }
  }
}

registerHtmlPreviewScheme();

// Keep the legacy resources/bundled lookup available for older developer
// builds. New packaged releases carry the standalone omp runtime binary in
// the installer and copy it into userData on first use.
{
  const candidates = [
    join(app.getAppPath(), "resources", "bundled"),
    join((process as any).resourcesPath || "", "bundled"),
  ];
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, ompBinaryFileName()))) {
      process.env.PI_BUNDLED_DIR = dir;
      break;
    }
  }
}

let mainWindow: BrowserWindow | null = null;
const getWin = () => mainWindow;

/** Resolve the app icon for the live window (dev + packaged). */
function resolveWindowIcon(): string | undefined {
  const names = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  const candidates = names.flatMap((name) => [
    join(app.getAppPath(), "resources", name),
    join((process as any).resourcesPath || "", name),
  ]);
  return candidates.find((p) => p && existsSync(p));
}

function createWindow(): void {
  const cfg = getConfig();
  const b = cfg.windowBounds;
  const windowIcon = resolveWindowIcon();
  mainWindow = new BrowserWindow({
    width: b?.width ?? 1440,
    height: b?.height ?? 920,
    x: b?.x,
    y: b?.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: "#0e0f12",
    title: "Omp Studio",
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (process.platform === "win32" && windowIcon) {
    // setIcon controls the HWND image; setAppDetails controls the Windows
    // taskbar button/group metadata. Development runs use electron.exe, so
    // both are required to avoid inheriting Electron's relaunch icon.
    mainWindow.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: windowIcon,
      appIconIndex: 0,
    });
  }

  mainWindow.on("ready-to-show", () => {
    if (!mainWindow) return;
    // On Windows, explicitly reapply the ICO after Chromium has created the
    // native HWND. This prevents development and upgraded installs from
    // falling back to Electron's executable icon in the taskbar.
    if (windowIcon) mainWindow.setIcon(windowIcon);
    if (b?.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  const sendMax = (v: boolean) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("window:maximized-changed", v);
  mainWindow.on("maximize", () => sendMax(true));
  mainWindow.on("unmaximize", () => sendMax(false));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Electron does not provide a page context menu automatically. Offer the
  // standard editing actions for inputs and Copy/Select All for selectable
  // transcript text so paragraph selections behave like a normal desktop app.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    const hasSelection = params.selectionText.length > 0;
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      template.push(
        { label: "剪切", enabled: params.editFlags.canCut, click: () => wc.cut() },
        { label: "复制", enabled: params.editFlags.canCopy, click: () => wc.copy() },
        { label: "粘贴", enabled: params.editFlags.canPaste, click: () => wc.paste() },
        { type: "separator" },
        { label: "全选", enabled: params.editFlags.canSelectAll, click: () => wc.selectAll() },
      );
    } else {
      template.push(
        { label: "复制", enabled: hasSelection && params.editFlags.canCopy, click: () => wc.copy() },
        { type: "separator" },
        { label: "全选", enabled: params.editFlags.canSelectAll, click: () => wc.selectAll() },
      );
    }

    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // Devtools toggle (F12 / Ctrl+Shift+I) — frameless windows have no default shortcut.
  mainWindow.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
      mainWindow?.webContents.toggleDevTools();
    }
  });
  // Forward renderer console to the main terminal so headless runs are diagnosable.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["log", "warn", "error"][level] || "log";
    // eslint-disable-next-line no-console
    console.log(`[renderer:${tag}] ${message}  (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    // eslint-disable-next-line no-console
    console.error("[renderer] process gone:", details.reason, details.exitCode);
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) mainWindow.loadURL(rendererUrl);
  else mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

// Single instance -----------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig(app.getPath("userData"));
    registerHtmlPreviewProtocol();
    // Remove runtime trees superseded by an in-app core update (they may have
    // been locked by pi child processes during the previous run; nothing holds
    // them now). Best effort — leftovers simply wait for the next launch.
    cleanupOldRuntimes();
    registerIpc(getWin);
    createWindow();
    startBackgroundAppUpdate(getWin);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      updateConfig({ windowBounds: { ...bounds, maximized: mainWindow.isMaximized() } });
    }
  } catch {
    /* ignore */
  }
  stopScheduler();
  stopAutomations();
  stopAllBridges();
});

app.on("window-all-closed", () => {
  stopScheduler();
  stopAutomations();
  stopAllBridges();
  if (process.platform !== "darwin") app.quit();
});
