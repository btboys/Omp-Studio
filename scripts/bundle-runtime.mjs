#!/usr/bin/env node
/**
 * Build the standalone Omp Studio runtime asset.
 *
 * Downloads the pinned oh-my-pi (`omp`) release binary for the current
 * platform/arch, verifies its sha256 against the digest published by the
 * GitHub releases API, and writes it plus the integrity manifest into
 * resources/ so electron-builder can embed it in the installer.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const EXPECTED_VERSION = process.env.OMP_RUNTIME_VERSION || APP_PACKAGE.ompRuntimeVersion || "17.2.12";
const RUNTIME_OUT = join(ROOT, "runtime-release");
const MANIFEST_OUT = join(ROOT, "resources", "runtime-manifest.json");
const RELEASES_API = "https://api.github.com/repos/can1357/oh-my-pi/releases/latest";

function log(message) {
  console.log(`[bundle-runtime] ${message}`);
}

/** Release asset name for the current platform/arch (e.g. omp-darwin-arm64). */
function ompBinaryFileName(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform;
  const name = `omp-${os}-${arch}`;
  return platform === "win32" ? `${name}.exe` : name;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function sha512Base64(file) {
  const hash = createHash("sha512");
  hash.update(readFileSync(file));
  return hash.digest("base64");
}

async function fetchJson(url, timeoutMs = 30_000) {
  // CI injects GH_TOKEN (GITHUB_TOKEN). GitHub's API rate-limits anonymous
  // callers to 60 req/h per shared runner IP — a 403 under load. Authenticate
  // whenever a token is available; local dev keeps the anonymous fallback.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = { accept: "application/json", "user-agent": "omp-studio-bundler" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadTo(url, dest, timeoutMs = 600_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const body = await res.arrayBuffer();
  writeFileSync(dest, Buffer.from(body));
}

/** Verify a sha256 hex digest (`sha256:<hex>`) from the releases API. */
function verifySha256(file, digest) {
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest || "");
  if (!m) return false;
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  return actual === m[1].toLowerCase();
}

async function main() {
  const fileName = ompBinaryFileName();
  if (!["win32", "darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Unsupported runtime target: ${process.platform}/${process.arch}. Use Windows, macOS or Linux on x64 or arm64.`);
  }

  log(`resolving latest release info (expecting v${EXPECTED_VERSION})`);
  const release = await fetchJson(RELEASES_API);
  const tag = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (tag !== EXPECTED_VERSION) {
    throw new Error(`Latest omp release is v${tag}, but package.json pins v${EXPECTED_VERSION}. Bump ompRuntimeVersion to match.`);
  }
  const asset = (release.assets || []).find((a) => a && a.name === fileName);
  if (!asset?.browser_download_url) {
    throw new Error(`Release v${EXPECTED_VERSION} has no ${fileName} asset.`);
  }
  const expectedSize = typeof asset.size === "number" ? asset.size : null;
  const expectedSha256 = typeof asset.digest === "string" ? asset.digest : null;

  rmSync(RUNTIME_OUT, { recursive: true, force: true });
  mkdirSync(RUNTIME_OUT, { recursive: true });
  const downloadPath = join(RUNTIME_OUT, fileName + ".download");
  log(`downloading ${fileName} (${expectedSize ? formatSize(expectedSize) : "unknown size"})`);
  await downloadTo(asset.browser_download_url, downloadPath);
  const size = statSync(downloadPath).size;
  if (expectedSize !== null && size !== expectedSize) {
    throw new Error(`size mismatch: expected ${expectedSize}, got ${size}`);
  }
  if (!verifySha256(downloadPath, expectedSha256)) {
    throw new Error("sha256 verification failed against the release digest");
  }
  if (process.platform !== "win32") chmodSync(downloadPath, 0o755);
  renameSync(downloadPath, join(RUNTIME_OUT, fileName));

  const manifest = {
    schema: 2,
    embedded: true,
    runtimeVersion: EXPECTED_VERSION,
    platform: process.platform,
    arch: process.arch,
    fileName,
    size,
    sha512: sha512Base64(join(RUNTIME_OUT, fileName)),
  };
  mkdirSync(dirname(MANIFEST_OUT), { recursive: true });
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  log(`runtime asset: ${fileName} (${formatSize(size)})`);
  log(`manifest: ${MANIFEST_OUT}`);
  log("done.");
}

try {
  await main();
} catch (error) {
  console.error(`[bundle-runtime] ${error.message || error}`);
  process.exitCode = 1;
}
