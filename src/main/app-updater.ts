import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

const REPOSITORY = "flowflic/Pi-Studio";
const RELEASES_LATEST_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOAD_ROOT = `https://github.com/${REPOSITORY}/releases/download`;
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export type AppUpdateStage = "checking" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateProgress {
  stage: AppUpdateStage;
  message: string;
  /** 0..100 when the download response includes a content length. */
  pct?: number;
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

interface ReleaseAsset {
  name: string;
  browser_download_url?: string;
  size?: number;
}

interface ResolvedRelease {
  tag: string;
  version: string;
  releaseUrl: string;
  assetName: string;
  assetUrl: string;
  sha512?: string;
  size?: number;
}

interface StagedUpdate {
  version: string;
  installerPath: string;
}

let stagedUpdate: StagedUpdate | null = null;

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

async function fetchText(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "text/plain, application/json, text/html",
      "user-agent": "Pi-Studio-update-check",
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

function yamlScalar(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(text);
  if (!match) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function releaseAssetUrl(tag: string, assetName: string): string {
  return `${DOWNLOAD_ROOT}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function findWindowsAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((asset) => /\.exe$/i.test(asset.name) && !/\.blockmap$/i.test(asset.name));
}

async function resolveFromApi(): Promise<ResolvedRelease> {
  const response = await fetchText(RELEASE_API_URL, { headers: { accept: "application/vnd.github+json" } });
  const release = (await response.json()) as {
    tag_name?: string;
    html_url?: string;
    assets?: ReleaseAsset[];
    draft?: boolean;
    prerelease?: boolean;
  };
  if (release.draft || release.prerelease) throw new Error("GitHub 返回的最新版本不是正式发布版本");
  const tag = String(release.tag_name || "").trim();
  const version = normalizeVersion(tag);
  const asset = findWindowsAsset(release.assets || []);
  if (!tag || !version || !asset) throw new Error("最新 Release 缺少 Windows 安装包");
  return {
    tag,
    version,
    releaseUrl: release.html_url || `${RELEASES_LATEST_URL}`,
    assetName: asset.name,
    assetUrl: asset.browser_download_url || releaseAssetUrl(tag, asset.name),
    size: asset.size,
  };
}

/**
 * GitHub's REST API can be rate-limited for anonymous clients. The latest
 * release page remains the canonical source and redirects to its tag; its
 * electron-builder latest.yml supplies the exact installer filename/hash.
 */
async function resolveFromLatestPage(): Promise<ResolvedRelease> {
  const response = await fetchText(RELEASES_LATEST_URL, { redirect: "follow" });
  const match = /\/releases\/tag\/([^/?#]+)/i.exec(response.url);
  if (!match) throw new Error("无法从 GitHub Releases latest 页面解析版本标签");
  const tag = decodeURIComponent(match[1]);
  const version = normalizeVersion(tag);
  if (!version) throw new Error("GitHub Releases latest 页面没有有效版本号");

  let assetName = `Pi-Studio-Setup-${version}.exe`;
  let sha512: string | undefined;
  let size: number | undefined;
  try {
    const manifestResponse = await fetchText(`${releaseAssetUrl(tag, "latest.yml")}`, { headers: { accept: "text/yaml, text/plain" } });
    const manifest = await manifestResponse.text();
    const manifestVersion = yamlScalar(manifest, "version");
    const manifestPath = yamlScalar(manifest, "path");
    if (manifestVersion && normalizeVersion(manifestVersion) !== version) {
      throw new Error(`latest.yml 版本 ${manifestVersion} 与标签 ${tag} 不一致`);
    }
    if (manifestPath && /\.exe$/i.test(manifestPath) && !/\.blockmap$/i.test(manifestPath)) assetName = manifestPath;
    sha512 = yamlScalar(manifest, "sha512");
    const rawSize = yamlScalar(manifest, "size");
    if (rawSize && /^\d+$/.test(rawSize)) size = Number(rawSize);
  } catch {
    // Older releases may not publish latest.yml; the configured electron-builder
    // artifact name is a safe fallback for the Windows release asset.
  }

  return {
    tag,
    version,
    releaseUrl: `${RELEASES_LATEST_URL}`,
    assetName,
    assetUrl: releaseAssetUrl(tag, assetName),
    sha512,
    size,
  };
}

async function resolveLatestRelease(): Promise<ResolvedRelease> {
  try {
    return await resolveFromLatestPage();
  } catch (pageError: any) {
    try {
      return await resolveFromApi();
    } catch (apiError: any) {
      throw new Error(`GitHub Releases 检查失败：${pageError?.message || apiError?.message || String(pageError)}`);
    }
  }
}

function isWindowsInstallerSupported(): boolean {
  return process.platform === "win32";
}

function isPackagedInstallable(): boolean {
  return isWindowsInstallerSupported() && app.isPackaged;
}

function currentStatus(current: string, release: ResolvedRelease): AppUpdateStatus {
  const hasUpdate = compareVersions(release.version, current) > 0;
  const supported = isWindowsInstallerSupported() && /\.exe$/i.test(release.assetName);
  const installable = supported && app.isPackaged;
  const downloaded = !!stagedUpdate && stagedUpdate.version === release.version && existsSync(stagedUpdate.installerPath);
  let note: string | null = "来源：GitHub Releases";
  if (supported && !installable) note = "当前为开发环境，只能检查版本；安装更新请使用已安装的 Pi Studio。";
  if (!supported) note = "当前平台暂无可用的 Pi Studio Windows 安装包。";
  return {
    current,
    latest: release.version,
    hasUpdate,
    source: "github",
    releaseUrl: release.releaseUrl,
    assetName: release.assetName,
    supported,
    installable,
    downloaded,
    note,
  };
}

export async function checkForAppUpdate(): Promise<AppUpdateStatus> {
  const current = normalizeVersion(app.getVersion());
  try {
    const release = await resolveLatestRelease();
    return currentStatus(current, release);
  } catch (e: any) {
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
      error: e?.message || String(e),
    };
  }
}

async function downloadFile(url: string, destination: string, expectedSize: number | undefined, onProgress: (pct: number) => void): Promise<void> {
  const response = await fetchText(url, undefined, DOWNLOAD_TIMEOUT_MS);
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) throw new Error("下载响应为空");
  const total = Number(response.headers.get("content-length")) || expectedSize || 0;
  const reader = body.getReader();
  const output = createWriteStream(destination);
  let received = 0;
  let lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (!output.write(chunk)) await new Promise<void>((resolve) => output.once("drain", resolve));
      if (total) {
        const pct = Math.min(99, Math.floor((received / total) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (received === 0) throw new Error("下载文件为空");
}

async function verifySha512(file: string, expected?: string): Promise<void> {
  if (!expected) return;
  const normalized = expected.replace(/^sha512-/i, "");
  const hash = createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  if (hash.digest("base64") !== normalized) throw new Error("安装包校验失败，文件可能已损坏");
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function downloadAppUpdate(onProgress?: (progress: AppUpdateProgress) => void): Promise<AppUpdateResult> {
  const progress = onProgress || (() => undefined);
  try {
    progress({ stage: "checking", message: "正在检查 GitHub Releases 最新版本…" });
    const release = await resolveLatestRelease();
    const status = currentStatus(normalizeVersion(app.getVersion()), release);
    if (!status.hasUpdate) return { ok: true, downloaded: false, version: status.current, message: `Pi Studio 已是最新版本（v${status.current}）` };
    if (!status.supported) throw new Error("当前平台没有可用的 Windows 安装包");
    if (!status.installable) throw new Error("开发环境不能自动安装应用更新，请使用已安装的 Pi Studio");

    const updateDir = join(app.getPath("temp"), "pi-studio-updates");
    mkdirSync(updateDir, { recursive: true });
    const installerPath = join(updateDir, safeFileName(release.assetName));
    rmSync(installerPath, { force: true });
    progress({ stage: "downloading", message: `正在下载 Pi Studio v${release.version}…`, pct: 0 });
    await downloadFile(release.assetUrl, installerPath, release.size, (pct) =>
      progress({ stage: "downloading", message: `正在下载 Pi Studio v${release.version}…`, pct }),
    );
    await verifySha512(installerPath, release.sha512);
    stagedUpdate = { version: release.version, installerPath };
    progress({ stage: "ready", message: `Pi Studio v${release.version} 已下载，可以安装并重启。`, pct: 100 });
    return { ok: true, downloaded: true, version: release.version, message: `Pi Studio v${release.version} 已下载，可以安装并重启。` };
  } catch (e: any) {
    const message = e?.message || String(e);
    progress({ stage: "error", message });
    return { ok: false, downloaded: false, message: `Pi Studio 更新失败：${message}` };
  }
}

function cmdQuote(value: string): string {
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

/**
 * Start a detached Windows command that waits for the current process to exit,
 * runs the NSIS installer silently, removes the temporary installer, and starts
 * the installed executable again. The helper owns the restart so the app is
 * not relaunched before the installer has released its files.
 */
function scheduleWindowsInstall(installerPath: string): void {
  const command = [
    "timeout /t 1 /nobreak >nul",
    `start "" /wait ${cmdQuote(installerPath)} /S`,
    `del /f /q ${cmdQuote(installerPath)} >nul 2>&1`,
    `start "" ${cmdQuote(process.execPath)}`,
  ].join(" & ");
  const helper = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  helper.unref();
}

export function installAppUpdate(): AppUpdateResult {
  if (!stagedUpdate || !existsSync(stagedUpdate.installerPath)) {
    return { ok: false, downloaded: false, message: "请先下载应用更新" };
  }
  if (!isPackagedInstallable()) {
    return { ok: false, downloaded: true, version: stagedUpdate.version, message: "当前环境不能自动安装应用更新" };
  }
  const version = stagedUpdate.version;
  try {
    scheduleWindowsInstall(stagedUpdate.installerPath);
    stagedUpdate = null;
    app.quit();
    return { ok: true, downloaded: true, version, message: `正在安装 Pi Studio v${version}，应用将自动重启。` };
  } catch (e: any) {
    return { ok: false, downloaded: true, version, message: `启动安装程序失败：${e?.message || String(e)}` };
  }
}
