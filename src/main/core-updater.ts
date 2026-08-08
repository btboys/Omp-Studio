import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getOmpVersion, resetPiRuntime, resolvePiRuntime } from "./pi-bridge";
import {
  activateRuntimeRoot,
  cleanupRuntimeVersions,
  getActiveRuntimeVersion,
  ompBinaryFileName,
  runtimeBaseDir as managedRuntimeBaseDir,
  runtimeVersionsDir,
} from "./runtime-package";

/**
 * In-app updater for the omp runtime that Omp Studio manages itself.
 *
 * The runtime managed by Omp Studio is NOT a global install, so `omp update`
 * refuses to touch it. Instead:
 *
 *   1. Ask the oh-my-pi GitHub releases API for the latest release.
 *   2. Download the platform binary asset (`omp-<os>-<arch>[.exe]`) and verify
 *      its sha256 against the digest the releases API publishes.
 *   3. Install it under `<userData>/runtime/versions/<version>/bin/` and switch
 *      `<userData>/runtime/current.json` to the new version.
 *
 * The previously active tree is renamed to `pi.old-<n>` rather than deleted:
 * a running thread may still hold the old binary open, which Windows refuses
 * to delete. Startup cleans them up.
 */

const RELEASES_URL = "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type UpdateStage = "checking" | "downloading" | "installing" | "pruning" | "activating" | "done" | "error";

export interface CoreUpdateProgress {
  stage: UpdateStage;
  message: string;
  /** 0..100 within the current stage, when known. */
  pct?: number;
}

export interface CoreUpdateStatus {
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  note?: string | null;
  /** Where the active app-managed runtime lives (legacy bundled dir or userData runtime). */
  source: "userData" | "bundled" | null;
  error?: string;
}

export interface CoreUpdateResult {
  ok: boolean;
  updated: boolean;
  from?: string | null;
  to?: string;
  message: string;
}

type ProgressFn = (p: CoreUpdateProgress) => void;

/* ------------------------------ locations ------------------------------ */

/** Root of the updatable runtime area under Electron's userData dir. */
export function runtimeBaseDir(): string {
  return managedRuntimeBaseDir();
}

interface ReleaseAsset {
  name?: string;
  size?: number;
  digest?: string;
  browser_download_url?: string;
}

interface ReleaseInfo {
  tag_name?: string;
  body?: string | null;
  assets?: ReleaseAsset[];
}

/** Version of the runtime the app currently uses (userData copy wins over bundled). */
export function readManagedPiStatus(): { version: string | null; source: "userData" | "bundled" | null } {
  const version = getActiveRuntimeVersion();
  return { version, source: version ? "userData" : null };
}

/* ------------------------------- helpers ------------------------------- */

/** Strip `omp/` / leading `v` and keep the numeric core (e.g. `17.2.9`). */
function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = String(raw).trim().replace(/^omp\//i, "").replace(/^v/i, "").split(/\s+/)[0] || "";
  if (!value) return null;
  const match = /^(\d+(?:\.\d+){0,3})(?:[-+].*)?$/.exec(value);
  return match?.[1] || value;
}

function compareVersions(a: string, b: string): number {
  const na = normalizeVersion(a) || "";
  const nb = normalizeVersion(b) || "";
  if (na === nb) return 0;
  const pa = na.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = nb.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Resolve the version shown to the user for update comparison.
 * Prefer `omp --version` (same as diagnostics) so Settings never claims
 * "可更新" while displaying equal current/latest strings.
 */
async function resolveCurrentCoreVersion(): Promise<{ version: string | null; source: CoreUpdateStatus["source"] }> {
  const managed = readManagedPiStatus();
  try {
    const rt = await resolvePiRuntime();
    const binary = normalizeVersion(await getOmpVersion(rt.bin));
    if (binary) return { version: binary, source: managed.source };
  } catch {
    /* fall through to managed pointer */
  }
  if (managed.version) {
    return { version: normalizeVersion(managed.version), source: managed.source };
  }
  return { version: null, source: managed.source };
}

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "omp-studio-updater" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Verify a file's sha256 hex digest (`sha256:<hex>` from the releases API). */
async function verifySha256(file: string, digest?: string): Promise<void> {
  if (!digest) return;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest);
  if (!m) return; // unknown scheme; don't hard-fail
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (d) => hash.update(d));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  const actual = hash.digest("hex");
  if (actual !== m[1].toLowerCase()) throw new Error(`integrity check failed for ${file} (sha256)`);
}

/** Download url → dest with optional coarse progress (needs content-length). */
async function downloadFile(url: string, dest: string, onPct?: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const body = res.body as unknown as { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  await new Promise<void>((resolve, reject) => {
    if (!body) {
      reject(new Error(`empty response body for ${url}`));
      return;
    }
    const reader = body.getReader();
    const out = createWriteStream(dest);
    let got = 0;
    let lastPct = -1;
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value as Uint8Array);
        got += buf.length;
        if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
        if (total && onPct) {
          const pct = Math.min(99, Math.floor((got / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            onPct(pct);
          }
        }
      }
      out.end(() => resolve());
      out.on("error", reject);
    };
    pump().catch((e) => {
      out.destroy();
      reject(e);
    });
  });
}

/**
 * rmSync that tolerates Windows file-lock races: antivirus/indexers
 * transiently hold handles on freshly written files, making plain recursive
 * rmSync fail with ENOTEMPTY/EBUSY. maxRetries makes Node back off and retry;
 * the outer try keeps cleanup paths from ever taking down the update flow —
 * leftovers are swept by cleanupOldRuntimes() on next launch.
 */
function rmSafe(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } catch {
    /* best effort */
  }
}

/** Find the platform asset in a release payload, or null when absent. */
function platformAsset(release: ReleaseInfo): ReleaseAsset | null {
  const fileName = ompBinaryFileName();
  return release.assets?.find((a) => a.name === fileName) || null;
}

/* ------------------------------ public API ------------------------------ */

/** Check the oh-my-pi GitHub releases feed for the latest omp version. */
export async function checkForCoreUpdate(): Promise<CoreUpdateStatus> {
  const { version: current, source } = await resolveCurrentCoreVersion();
  try {
    const release = await fetchJson<ReleaseInfo>(RELEASES_URL);
    const latest = normalizeVersion(typeof release.tag_name === "string" ? release.tag_name : "");
    if (!latest) return { current, latest: null, hasUpdate: false, source, error: "版本检查返回为空" };
    // Only mark updatable when we know current AND latest is strictly newer.
    // Previously `current == null` forced hasUpdate=true, which made Settings show
    // "可更新" even when the displayed diag.ompVersion already matched latest.
    const hasUpdate = Boolean(current && compareVersions(latest, current) > 0);
    return { current, latest, hasUpdate, note: release.body?.slice(0, 200) || null, source };
  } catch (e: any) {
    return { current, latest: null, hasUpdate: false, source, error: e?.message || String(e) };
  }
}

/**
 * Download and activate the latest omp runtime. Safe to call when already
 * latest (resolves with updated=false). Progress is reported via onProgress.
 */
export async function installCoreUpdate(onProgress?: ProgressFn): Promise<CoreUpdateResult> {
  const progress: ProgressFn = onProgress || (() => undefined);
  const base = runtimeBaseDir();
  const staging = join(base, `.staging-${process.pid}`);

  try {
    // ---- check -----------------------------------------------------------
    progress({ stage: "checking", message: "正在检查最新版本…" });
    const status = await checkForCoreUpdate();
    if (status.error) throw new Error(`检查更新失败：${status.error}`);
    if (!status.latest) throw new Error("无法获取最新版本信息");
    if (!status.hasUpdate && status.current) {
      return { ok: true, updated: false, from: status.current, message: `omp 已是最新版本（v${status.current}）` };
    }
    // If current could not be resolved, continue and install latest rather than
    // falsely claiming we are already up to date.
    const targetVersion = status.latest;
    progress({ stage: "checking", message: `发现新版本 v${targetVersion}（当前 v${status.current || "?"}）` });

    // ---- resolve release asset -------------------------------------------
    const release = await fetchJson<ReleaseInfo>(RELEASES_URL);
    const asset = platformAsset(release);
    if (!asset?.browser_download_url) {
      throw new Error(`该版本没有 ${ompBinaryFileName()} 安装包`);
    }

    // ---- stage area ------------------------------------------------------
    rmSafe(staging);
    mkdirSync(staging, { recursive: true });
    const downloadPath = join(staging, ompBinaryFileName());

    progress({ stage: "downloading", message: "正在下载 omp 核心…", pct: 0 });
    await downloadFile(asset.browser_download_url, downloadPath, (pct) =>
      progress({ stage: "downloading", message: "正在下载 omp 核心…", pct }),
    );
    await verifySha256(downloadPath, asset.digest);

    // ---- install ----------------------------------------------------------
    progress({ stage: "installing", message: "正在安装 omp 核心…" });
    const targetRoot = join(runtimeVersionsDir(), targetVersion);
    const binDir = join(targetRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    rmSafe(targetRoot);
    mkdirSync(binDir, { recursive: true });
    renameSync(downloadPath, join(binDir, ompBinaryFileName()));
    if (process.platform !== "win32") {
      try {
        chmodSync(join(binDir, ompBinaryFileName()), 0o755);
      } catch {
        /* best effort */
      }
    }

    // ---- activate ---------------------------------------------------------
    progress({ stage: "activating", message: "正在激活新版本…" });
    activateRuntimeRoot(targetRoot, targetVersion);
    rmSafe(staging);
    resetPiRuntime(); // next thread open resolves the new runtime

    progress({ stage: "done", message: `已更新到 v${targetVersion}` });
    return {
      ok: true,
      updated: true,
      from: status.current,
      to: targetVersion,
      message: `omp 核心已更新到 v${targetVersion}，新开的会话将使用新版本。`,
    };
  } catch (e: any) {
    rmSafe(staging);
    const message = e?.message || String(e);
    progress({ stage: "error", message });
    return { ok: false, updated: false, message: `omp 更新失败：${message}` };
  }
}

/**
 * Best-effort removal of superseded runtime trees and stale staging dirs.
 * Called at startup, when no omp child process can hold files open.
 */
export function cleanupOldRuntimes(): void {
  let base: string;
  try {
    base = runtimeBaseDir();
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return; // runtime dir never created
  }
  for (const name of entries) {
    if (/^pi\.old-/.test(name) || /^\.staging-/.test(name)) {
      rmSafe(join(base, name)); // still locked → silently retried next launch
    }
  }
  cleanupRuntimeVersions();
}
