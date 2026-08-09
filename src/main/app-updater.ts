import { app } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateCheckResult, type UpdateInfo } from "electron-updater";
import { checkForCoreUpdate } from "./core-updater";

/** Keep in sync with package.json build.publish. */
const REPOSITORY = "btboys/Omp-Studio";
const RELEASES_LATEST_URL = "https://github.com/" + REPOSITORY + "/releases/latest";
const RELEASES_API_URL = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
const FETCH_TIMEOUT_MS = 30_000;

export type AppUpdateStage = "checking" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateProgress {
  stage: AppUpdateStage;
  message: string;
  /** 0..100 while electron-updater reports download progress. */
  pct?: number;
  /** Version this progress refers to (normalized, e.g. "0.4.1"). */
  version?: string;
}

export interface AppUpdateStatus {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  source: "github" | null;
  releaseUrl: string | null;
  assetName: string | null;
  /** Whether this platform has a supported installer asset. */
  supported: boolean;
  /** Whether the current process can install and restart the packaged app. */
  installable: boolean;
  downloaded: boolean;
  note?: string | null;
  error?: string;
}

export interface AppUpdateResult {
  ok: boolean;
  downloaded: boolean;
  version?: string | null;
  message: string;
}

let configured = false;
let latestUpdateInfo: UpdateInfo | null = null;
let downloadedVersion: string | null = null;
let lastUpdaterError: string | null = null;
let checkPromise: Promise<UpdateCheckResult | null> | null = null;
let downloadPromise: Promise<Array<string>> | null = null;
let progressSink: ((progress: AppUpdateProgress) => void) | null = null;

function normalizeVersion(raw: string): string {
  const value = String(raw || "").trim().replace(/^v/i, "");
  const match = /^(\d+(?:\.\d+){0,2})(?:[-+].*)?$/.exec(value);
  return match?.[1] || value;
}

function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function isWindowsInstallerSupported(): boolean {
  return process.platform === "win32";
}

function isPackagedInstallable(): boolean {
  return isWindowsInstallerSupported() && app.isPackaged;
}

function emitProgress(progress: AppUpdateProgress): void {
  try {
    progressSink?.(progress);
  } catch {
    // A renderer can disappear while the updater is still downloading.
    progressSink = null;
  }
}

function updateAssetName(info: UpdateInfo): string | null {
  const exeFile = info.files?.find((file) => /\.exe(?:$|\?)/i.test(file.url) && !/\.blockmap/i.test(file.url));
  const raw = info.path || exeFile?.url || "";
  if (!raw) return null;
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  return decodeURIComponent(withoutQuery.split(/[\\/]/).pop() || withoutQuery);
}

function releaseUrl(version: string): string {
  return "https://github.com/" + REPOSITORY + "/releases/tag/v" + encodeURIComponent(version);
}

function isWindowsUpdateInfo(info: UpdateInfo): boolean {
  return Boolean(updateAssetName(info) && /\.exe$/i.test(updateAssetName(info) || ""));
}

function statusNote(supported: boolean, installable: boolean): string {
  if (supported && installable) {
    return "来源：GitHub Releases，由 electron-updater 管理下载和安装";
  }
  if (supported && !installable) {
    // Windows platform, but this process is not a packaged installer build.
    return "当前为开发环境，只能检查版本；请使用已安装的 Omp Studio 执行更新";
  }
  if (app.isPackaged) {
    // macOS/Linux packaged installs are real releases; only in-app install is Windows-only.
    return "当前为已安装的正式版；应用内自动下载/安装目前仅支持 Windows，仍可检查最新版本号，macOS 请从 GitHub Releases 手动下载 DMG";
  }
  return "当前平台没有可用的 Omp Studio Windows 安装包（仍可检查最新版本号）";
}

function statusFromInfo(current: string, info: UpdateInfo): AppUpdateStatus {
  const latest = normalizeVersion(info.version);
  const supported = isWindowsInstallerSupported() && isWindowsUpdateInfo(info);
  const installable = supported && app.isPackaged;
  const hasUpdate = compareVersions(latest, current) > 0;

  return {
    current,
    latest,
    hasUpdate,
    source: "github",
    releaseUrl: releaseUrl(latest),
    assetName: updateAssetName(info),
    supported,
    installable,
    downloaded: downloadedVersion === latest,
    note: statusNote(supported, installable),
    ...(lastUpdaterError ? { error: lastUpdaterError } : {}),
  };
}

function emptyStatus(current: string, error?: string): AppUpdateStatus {
  return {
    current,
    latest: null,
    hasUpdate: false,
    source: null,
    releaseUrl: RELEASES_LATEST_URL,
    assetName: null,
    supported: isWindowsInstallerSupported(),
    installable: isPackagedInstallable(),
    downloaded: false,
    note: statusNote(isWindowsInstallerSupported(), isPackagedInstallable()),
    ...(error ? { error } : {}),
  };
}

interface GithubReleaseMeta {
  version: string;
  assetName: string | null;
}

interface GithubReleaseAsset {
  name?: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  assets?: GithubReleaseAsset[];
}

function windowsAssetName(assets: GithubReleaseAsset[] | undefined): string | null {
  const exe = (assets || []).find(
    (asset) => typeof asset.name === "string" && /\.exe$/i.test(asset.name) && !/\.blockmap/i.test(asset.name),
  );
  return exe?.name || null;
}

function statusFromGithubMeta(current: string, meta: GithubReleaseMeta): AppUpdateStatus {
  const latest = normalizeVersion(meta.version);
  // Redirect fallback may not include asset names; only mark unsupported when
  // the API explicitly returned a release without a Windows installer.
  const supported =
    isWindowsInstallerSupported() && (meta.assetName == null || /\.exe$/i.test(meta.assetName));
  const installable = supported && app.isPackaged;
  return {
    current,
    latest,
    hasUpdate: compareVersions(latest, current) > 0,
    source: "github",
    releaseUrl: releaseUrl(latest),
    assetName: meta.assetName,
    supported,
    installable,
    downloaded: downloadedVersion === latest,
    note: statusNote(supported, installable),
    ...(lastUpdaterError ? { error: lastUpdaterError } : {}),
  };
}

async function fetchLatestFromApi(): Promise<GithubReleaseMeta | null> {
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Omp-Studio-Updater",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("GitHub API HTTP " + response.status);
  }
  const payload = (await response.json()) as GithubReleasePayload;
  const version = normalizeVersion(payload.tag_name || payload.name || "");
  if (!version) return null;
  return { version, assetName: windowsAssetName(payload.assets) };
}

/** Fallback that only needs the releases/latest redirect Location header. */
async function fetchLatestFromRedirect(): Promise<GithubReleaseMeta | null> {
  const response = await fetch(RELEASES_LATEST_URL, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "Omp-Studio-Updater" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const location = response.headers.get("location") || "";
  const match = /\/releases\/tag\/([^/?#]+)/i.exec(location);
  if (!match?.[1]) return null;
  return {
    version: normalizeVersion(decodeURIComponent(match[1])),
    assetName: null,
  };
}

async function fetchLatestReleaseMeta(): Promise<GithubReleaseMeta> {
  try {
    const fromApi = await fetchLatestFromApi();
    if (fromApi?.version) return fromApi;
  } catch (error: any) {
    // Rate limits / network blips: fall through to the HTML redirect probe.
    console.warn("[app-updater] GitHub API check failed:", error?.message || error);
  }

  const fromRedirect = await fetchLatestFromRedirect();
  if (fromRedirect?.version) return fromRedirect;
  throw new Error("无法从 GitHub Releases 解析最新版本号");
}

function configureUpdater(): void {
  if (configured) return;
  configured = true;

  // The settings page explicitly controls when to download/install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (message?: unknown) => console.info("[electron-updater]", message),
    warn: (message?: unknown) => console.warn("[electron-updater]", message),
    error: (message?: unknown) => console.error("[electron-updater]", message),
  };

  autoUpdater.on("checking-for-update", () => {
    emitProgress({ stage: "checking", message: "正在检查 GitHub Releases 最新版本…" });
  });

  autoUpdater.on("update-available", (info) => {
    latestUpdateInfo = info;
    lastUpdaterError = null;
    const version = normalizeVersion(info.version);
    if (downloadedVersion && downloadedVersion !== version) downloadedVersion = null;
  });

  autoUpdater.on("update-not-available", (info) => {
    latestUpdateInfo = info;
    lastUpdaterError = null;
  });

  autoUpdater.on("download-progress", (info: ProgressInfo) => {
    const pct = Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : undefined;
    emitProgress({
      stage: "downloading",
      message: "正在下载 Omp Studio v" + normalizeVersion(latestUpdateInfo?.version || "") + "…",
      ...(pct === undefined ? {} : { pct }),
      version: normalizeVersion(latestUpdateInfo?.version || "") || undefined,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    latestUpdateInfo = info;
    downloadedVersion = normalizeVersion(info.version);
    emitProgress({
      stage: "ready",
      message: "Omp Studio v" + downloadedVersion + " 已下载，可以安装并重启",
      pct: 100,
      version: downloadedVersion,
    });
  });

  autoUpdater.on("error", (error, message) => {
    lastUpdaterError = message || error?.message || String(error);
    emitProgress({ stage: "error", message: lastUpdaterError });
  });
}

async function checkWithUpdater(): Promise<UpdateCheckResult | null> {
  configureUpdater();
  if (checkPromise) return checkPromise;
  checkPromise = autoUpdater.checkForUpdates().finally(() => {
    checkPromise = null;
  });
  return checkPromise;
}

export async function checkForAppUpdate(): Promise<AppUpdateStatus> {
  configureUpdater();
  const current = normalizeVersion(app.getVersion());
  lastUpdaterError = null;

  try {
    // Always resolve the latest version from GitHub so the Settings UI can
    // show it in development and on non-Windows platforms. Download/install
    // still go through electron-updater and remain Windows+packaged only.
    const meta = await fetchLatestReleaseMeta();

    if (isPackagedInstallable()) {
      try {
        const result = await checkWithUpdater();
        const info = result?.updateInfo || latestUpdateInfo;
        if (info) return statusFromInfo(current, info);
      } catch (error: any) {
        // Keep the GitHub meta result; surface updater failure as a soft note.
        lastUpdaterError = error?.message || String(error);
      }
    }

    return statusFromGithubMeta(current, meta);
  } catch (error: any) {
    const message = error?.message || String(error);
    lastUpdaterError = message;
    return emptyStatus(current, message);
  }
}

export async function downloadAppUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<AppUpdateResult> {
  configureUpdater();
  const previousSink = progressSink;
  progressSink = onProgress || null;
  lastUpdaterError = null;

  try {
    if (!isPackagedInstallable()) {
      throw new Error("当前环境不能自动安装应用更新，请使用已安装的 Omp Studio");
    }

    const result = await checkWithUpdater();
    const info = result?.updateInfo || latestUpdateInfo;
    if (!info) throw new Error("更新服务没有返回版本信息");

    latestUpdateInfo = info;
    const current = normalizeVersion(app.getVersion());
    const status = statusFromInfo(current, info);
    if (!status.hasUpdate) {
      return {
        ok: true,
        downloaded: false,
        version: status.current,
        message: "Omp Studio 已经是最新版本（v" + status.current + "）",
      };
    }
    if (!status.supported) throw new Error("更新服务没有返回 Windows 安装包");

    const version = normalizeVersion(info.version);
    if (downloadedVersion === version) {
      emitProgress({ stage: "ready", message: "Omp Studio v" + version + " 已下载，可以安装并重启", pct: 100, version });
      return {
        ok: true,
        downloaded: true,
        version,
        message: "Omp Studio v" + version + " 已下载，可以安装并重启",
      };
    }

    emitProgress({ stage: "downloading", message: "正在下载 Omp Studio v" + version + "…", pct: 0, version });
    if (!downloadPromise) {
      downloadPromise = autoUpdater.downloadUpdate().finally(() => {
        downloadPromise = null;
      });
    }
    await downloadPromise;

    if (downloadedVersion !== version) {
      throw new Error("更新下载完成但没有收到 update-downloaded 事件");
    }
    return {
      ok: true,
      downloaded: true,
      version,
      message: "Omp Studio v" + version + " 已下载，可以安装并重启",
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    lastUpdaterError = message;
    emitProgress({ stage: "error", message });
    return { ok: false, downloaded: false, message: "Omp Studio 更新失败：" + message };
  } finally {
    if (progressSink === onProgress) progressSink = previousSink;
  }
}

export function installAppUpdate(): AppUpdateResult {
  configureUpdater();
  if (!downloadedVersion) {
    return { ok: false, downloaded: false, message: "请先下载应用更新" };
  }
  if (!isPackagedInstallable()) {
    return {
      ok: false,
      downloaded: true,
      version: downloadedVersion,
      message: "当前环境不能自动安装应用更新",
    };
  }

  const version = downloadedVersion;
  lastUpdaterError = null;
  emitProgress({ stage: "installing", message: "正在安装 Omp Studio v" + version + "，应用将自动重启", version });
  try {
    // electron-updater invokes the NSIS updater, waits for this process to
    // exit, installs the downloaded package, and relaunches the app.
    autoUpdater.quitAndInstall(true, true);
    if (lastUpdaterError) {
      return { ok: false, downloaded: true, version, message: "启动安装程序失败：" + lastUpdaterError };
    }
    return {
      ok: true,
      downloaded: true,
      version,
      message: "正在安装 Omp Studio v" + version + "，应用将自动重启",
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    lastUpdaterError = message;
    emitProgress({ stage: "error", message });
    return { ok: false, downloaded: true, version, message: "启动安装程序失败：" + message };
  }
}

/** Defer installing the cached download: install when the app quits, so the
 *  next launch runs the new version. No-op when nothing is downloaded yet. */
export function deferAppUpdate(): AppUpdateResult {
  configureUpdater();
  if (!downloadedVersion) {
    return { ok: false, downloaded: false, message: "请先下载应用更新" };
  }
  autoUpdater.autoInstallOnAppQuit = true;
  return {
    ok: true,
    downloaded: true,
    version: downloadedVersion,
    message: "将在下次启动前安装 Omp Studio v" + downloadedVersion,
  };
}

/**
 * Startup update flow: silently check both update sources a few seconds after
 * launch, then refresh them hourly. Works on every platform.
 *
 *  - `pi:updateStatus` is always pushed with the combined app + omp-core
 *    status; the title bar renders update badges from it.
 *  - Windows packaged: a new app version is downloaded in the background and
 *    the renderer shows the install prompt when it lands ("ready" on
 *    pi:appUpdate).
 *  - macOS/Linux packaged (and dev builds): no in-app installer exists, so an
 *    available app update surfaces a one-shot "available" prompt (per launch)
 *    that links to the GitHub release page.
 * Never throws; a failed check/download must not disturb startup.
 */
export function startBackgroundAppUpdate(getWin: () => Electron.BrowserWindow | null): void {
  configureUpdater();
  const send = (channel: string, payload: unknown): void => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  // Windows packaged: arm install-on-quit from launch. Any download that
  // completes this session then installs when the app quits cleanly, even if
  // the user never answered the update prompt. install() is a no-op when
  // nothing is downloaded, so arming it is safe.
  if (app.isPackaged && isWindowsInstallerSupported()) autoUpdater.autoInstallOnAppQuit = true;

  // One-shot per launch: on platforms without an in-app installer, prompt for
  // an available app update exactly once instead of nagging on every refresh.
  let prompted = false;

  const run = async (): Promise<void> => {
    try {
      const [appStatus, coreStatus] = await Promise.all([checkForAppUpdate(), checkForCoreUpdate()]);
      send("pi:updateStatus", { app: appStatus, core: coreStatus });

      if (!appStatus.hasUpdate) return;

      if (appStatus.supported && appStatus.installable) {
        // Windows packaged: download in the background; AppUpdateModal prompts on "ready".
        await downloadAppUpdate((p) => send("pi:appUpdate", p));
      } else if (!prompted) {
        // macOS/Linux (and dev): no in-app installer — surface the release page.
        prompted = true;
        send("pi:appUpdate", {
          stage: "available",
          version: appStatus.latest || undefined,
          message: appStatus.note || `Omp Studio v${appStatus.latest} is available`,
          releaseUrl: appStatus.releaseUrl || undefined,
        });
      }
    } catch (error: any) {
      console.warn("[app-updater] background update flow failed:", error?.message || String(error));
    }
  };

  // Check shortly after launch (window exists by then), then keep the title-bar
  // badges fresh hourly so a release mid-session still shows up.
  setTimeout(() => void run(), 4000);
  setInterval(() => void run(), 60 * 60 * 1000);
}
