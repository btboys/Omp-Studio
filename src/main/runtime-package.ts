import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import { getConfigDir } from "./config";

/**
 * The omp (oh-my-pi) binary is embedded in the desktop installer and copied
 * once into userData. Keeping the extracted copy versioned still lets
 * app-managed omp updates switch runtimes without replacing files held by
 * live processes.
 */
export interface RuntimeManifest {
  schema: 2;
  embedded: true;
  runtimeVersion: string;
  platform: RuntimePlatform;
  arch: RuntimeArch;
  fileName: string;
  size: number;
  sha512: string;
}

type RuntimePlatform = "win32" | "darwin" | "linux";
type RuntimeArch = "x64" | "arm64";

function supportsEmbeddedRuntime(): boolean {
  return (
    (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") &&
    (process.arch === "x64" || process.arch === "arm64")
  );
}

/**
 * Release asset name for a platform/arch pair, matching oh-my-pi's GitHub
 * releases: `omp-<os>-<arch>` with os ∈ darwin|linux|windows, `.exe` on win32.
 */
export function ompBinaryFileName(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const name = `omp-${os}-${arch}`;
  return platform === "win32" ? `${name}.exe` : name;
}

export interface RuntimePaths {
  bin: string;
}

export type RuntimeProgressStage = "checking" | "installing" | "activating" | "done" | "error";

export interface RuntimeProgress {
  stage: RuntimeProgressStage;
  message: string;
  pct?: number;
}

type ProgressFn = (progress: RuntimeProgress) => void;

interface RuntimePointer {
  schema: 1;
  version: string;
}

let installPromise: Promise<string | null> | null = null;

export function runtimeBaseDir(): string {
  const dir = getConfigDir();
  if (!dir) throw new Error("config not loaded; cannot resolve runtime dir");
  return join(dir, "runtime");
}

export function runtimeVersionsDir(): string {
  return join(runtimeBaseDir(), "versions");
}

function runtimePointerPath(): string {
  return join(runtimeBaseDir(), "current.json");
}

function isValidRuntimeVersion(version: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version);
}

/** Compare dotted numeric versions; negative when a < b, 0 when equal. */
function compareVersions(a: string, b: string): number {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function runtimeRootForVersion(version: string): string {
  if (!isValidRuntimeVersion(version)) throw new Error(`invalid runtime version: ${version}`);
  return join(runtimeVersionsDir(), version);
}

function isUsableRuntimeRoot(root: string): boolean {
  return existsSync(join(root, "bin", ompBinaryFileName()));
}

export function runtimePathsForRoot(root: string): RuntimePaths | null {
  const paths = { bin: join(root, "bin", ompBinaryFileName()) };
  return existsSync(paths.bin) ? paths : null;
}

function readPointer(): RuntimePointer | null {
  try {
    const parsed = JSON.parse(readFileSync(runtimePointerPath(), "utf8")) as Partial<RuntimePointer>;
    if (parsed.schema !== 1 || typeof parsed.version !== "string" || !isValidRuntimeVersion(parsed.version)) return null;
    return { schema: 1, version: parsed.version };
  } catch {
    return null;
  }
}

/** Resolve the active runtime root from the version pointer. */
export function getActiveRuntimeRoot(): string | null {
  try {
    const pointer = readPointer();
    if (pointer) {
      const pointed = runtimeRootForVersion(pointer.version);
      if (isUsableRuntimeRoot(pointed)) return pointed;
    }
  } catch {
    /* config may not be loaded yet */
  }
  return null;
}

export function getActiveRuntimeVersion(): string | null {
  const pointer = readPointer();
  if (pointer && isUsableRuntimeRoot(runtimeRootForVersion(pointer.version))) return pointer.version;
  return null;
}

export function getActiveRuntimePaths(): RuntimePaths | null {
  const root = getActiveRuntimeRoot();
  return root ? runtimePathsForRoot(root) : null;
}

/** Atomically switch new processes to a versioned runtime directory. */
export function activateRuntimeRoot(root: string, version: string): void {
  const base = resolve(runtimeBaseDir());
  const candidate = resolve(root);
  if (candidate !== base && !candidate.startsWith(base + "\\") && !candidate.startsWith(base + "/")) {
    throw new Error("runtime root is outside the app runtime directory");
  }
  if (!isUsableRuntimeRoot(candidate)) throw new Error(`runtime package is incomplete: ${candidate}`);

  mkdirSync(base, { recursive: true });
  const pointerPath = runtimePointerPath();
  const tempPath = `${pointerPath}.${process.pid}.${Date.now()}.tmp`;
  const pointer: RuntimePointer = { schema: 1, version };
  writeFileSync(tempPath, JSON.stringify(pointer, null, 2), "utf8");
  try {
    // Windows rename does not replace an existing file. The pointer is tiny,
    // and removing it here leaves only a short, recoverable gap.
    rmSafe(pointerPath);
    renameSync(tempPath, pointerPath);
  } catch (error) {
    rmSafe(tempPath);
    throw error;
  }
}

function runtimeManifestPath(): string | null {
  if (!app.isPackaged || !supportsEmbeddedRuntime()) return null;
  const resourcesPath = (process as any).resourcesPath as string | undefined;
  return resourcesPath ? join(resourcesPath, "runtime-manifest.json") : null;
}

export function getRuntimePackageManifest(): RuntimeManifest | null {
  const path = runtimeManifestPath();
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeManifest>;
    if (
      parsed.schema !== 2 ||
      parsed.embedded !== true ||
      !supportsEmbeddedRuntime() ||
      parsed.platform !== process.platform ||
      parsed.arch !== process.arch ||
      typeof parsed.runtimeVersion !== "string" ||
      !isValidRuntimeVersion(parsed.runtimeVersion) ||
      typeof parsed.fileName !== "string" ||
      parsed.fileName !== ompBinaryFileName() ||
      typeof parsed.size !== "number" ||
      parsed.size <= 0 ||
      typeof parsed.sha512 !== "string"
    ) {
      return null;
    }
    return parsed as RuntimeManifest;
  } catch {
    return null;
  }
}

function embeddedRuntimeBinaryPath(manifest: RuntimeManifest): string {
  const resourcesPath = (process as any).resourcesPath as string | undefined;
  if (!app.isPackaged || !resourcesPath) {
    throw new Error("embedded omp runtime is only available in a packaged app");
  }
  const binary = join(resourcesPath, "runtime-package", manifest.fileName);
  if (!existsSync(binary)) {
    throw new Error(`embedded omp runtime package is missing: ${binary}`);
  }
  return binary;
}

function rmSafe(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  } catch {
    /* best effort; stale paths are retried on the next launch */
  }
}

async function sha512File(file: string): Promise<string> {
  const hash = createHash("sha512");
  const input = createReadStream(file);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

/** Verify, copy and activate the omp binary embedded in the installer. */
export async function installRuntimePackage(manifest: RuntimeManifest, onProgress?: ProgressFn): Promise<string> {
  if (!supportsEmbeddedRuntime()) {
    throw new Error("standalone omp runtime supports Windows, macOS and Linux on x64 or arm64");
  }
  const progress = onProgress || (() => undefined);
  const target = runtimeRootForVersion(manifest.runtimeVersion);
  if (isUsableRuntimeRoot(target)) {
    activateRuntimeRoot(target, manifest.runtimeVersion);
    progress({ stage: "done", message: `omp runtime v${manifest.runtimeVersion} is ready`, pct: 100 });
    return target;
  }

  const base = runtimeBaseDir();
  const embeddedBinary = embeddedRuntimeBinaryPath(manifest);
  const staging = join(base, `.runtime-staging-${process.pid}-${Date.now()}`);
  const stagedBinary = join(staging, manifest.fileName);
  try {
    rmSafe(staging);
    mkdirSync(staging, { recursive: true });
    progress({ stage: "checking", message: `Preparing embedded omp runtime v${manifest.runtimeVersion}` });
    copyFileSync(embeddedBinary, stagedBinary);
    const actualSize = statSync(stagedBinary).size;
    if (actualSize !== manifest.size) throw new Error(`runtime package size mismatch: expected ${manifest.size}, got ${actualSize}`);
    const actualHash = await sha512File(stagedBinary);
    if (actualHash !== manifest.sha512) throw new Error("runtime package integrity check failed");

    progress({ stage: "installing", message: "Installing omp runtime", pct: 0 });
    mkdirSync(runtimeVersionsDir(), { recursive: true });
    rmSafe(target);
    const binDir = join(target, "bin");
    mkdirSync(binDir, { recursive: true });
    renameSync(stagedBinary, join(binDir, manifest.fileName));
    if (process.platform !== "win32") {
      try {
        chmodSync(join(binDir, manifest.fileName), 0o755);
      } catch {
        /* best effort; the file is copied from a packaged resource */
      }
    }
    if (!isUsableRuntimeRoot(target)) throw new Error("runtime package activation produced an incomplete directory");
    progress({ stage: "activating", message: `Activating omp runtime v${manifest.runtimeVersion}` });
    activateRuntimeRoot(target, manifest.runtimeVersion);
    progress({ stage: "done", message: `omp runtime v${manifest.runtimeVersion} is ready`, pct: 100 });
    return target;
  } finally {
    rmSafe(staging);
  }
}

/**
 * Upgrade the managed runtime when the installed app bundles a newer omp than
 * the active userData copy. App updates must not leave users stuck on the
 * previous app's runtime; this runs at startup before the window opens so the
 * version shown matches the binary in use. Never downgrades: a runtime updated
 * in-app beyond the bundled version is kept. No-op without an embedded runtime
 * (dev mode) or when the active copy is already current or newer.
 */
export async function ensureManagedRuntimeUpToDate(onProgress?: ProgressFn): Promise<string | null> {
  const manifest = getRuntimePackageManifest();
  if (!manifest) return null;
  const activeVersion = getActiveRuntimeVersion();
  if (activeVersion && compareVersions(manifest.runtimeVersion, activeVersion) <= 0) return null;
  return installRuntimePackage(manifest, onProgress);
}

/** Ensure the runtime embedded in the installer is present on first launch. */
export function ensureRuntimePackage(onProgress?: ProgressFn): Promise<string | null> {
  const active = getActiveRuntimePaths();
  if (active) return Promise.resolve(getActiveRuntimeRoot());
  const manifest = getRuntimePackageManifest();
  if (!manifest) return Promise.resolve(null);
  if (!installPromise) {
    installPromise = installRuntimePackage(manifest, onProgress).catch((error) => {
      installPromise = null;
      throw error;
    });
  }
  return installPromise;
}

/** Remove superseded version directories after no child process can hold them. */
export function cleanupRuntimeVersions(): void {
  let versions: string[];
  try {
    versions = readdirSync(runtimeVersionsDir());
  } catch {
    return;
  }
  const active = getActiveRuntimeRoot();
  for (const version of versions) {
    const candidate = join(runtimeVersionsDir(), version);
    if (candidate !== active) rmSafe(candidate);
  }
}
