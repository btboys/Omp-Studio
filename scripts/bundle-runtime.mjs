#!/usr/bin/env node
/**
 * bundle-runtime.mjs
 *
 * Copies the Node.js binary and the pi-coding-agent package (with all runtime
 * dependencies) into resources/bundled/ so that the packaged Electron app is
 * fully self-contained — no external Node.js or pi installation required.
 *
 * Usage:  node scripts/bundle-runtime.mjs
 *
 * The script:
 *  1. Locates the current node binary and copies it to resources/bundled/node/
 *  2. Copies pi-coding-agent dist/ + node_modules/ + package.json to resources/bundled/pi/
 *  3. Prunes source maps, type declarations, @types, test dirs, and docs to reduce size
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "resources", "bundled");
const NODE_OUT = join(OUT, "node");
const PI_OUT = join(OUT, "pi");

function log(msg) {
  console.log(`[bundle-runtime] ${msg}`);
}

function du(dir) {
  try {
    const out = execSync(`du -sh "${dir}"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return out.trim().split("\t")[0];
  } catch {
    return "?";
  }
}

// --- 1. Node binary ---------------------------------------------------------

function bundleNode() {
  const nodePath = process.execPath;
  const nodeExe = process.platform === "win32" ? "node.exe" : "node";
  const dest = join(NODE_OUT, nodeExe);

  if (existsSync(dest) && statSync(dest).size === statSync(nodePath).size && statSync(dest).mtimeMs >= statSync(nodePath).mtimeMs) {
    log(`node already bundled (${du(NODE_OUT)}), skipping`);
    return;
  }

  log(`copying node binary: ${nodePath} → ${dest}`);
  mkdirSync(NODE_OUT, { recursive: true });
  cpSync(nodePath, dest);
  log(`node bundled: ${du(NODE_OUT)}`);
}

// --- 2. pi-coding-agent package ---------------------------------------------

function locatePiPackage() {
  // Try to resolve from the global npm install
  try {
    const out = execSync("npm root -g", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const pkg = join(out, "@earendil-works", "pi-coding-agent");
    if (existsSync(join(pkg, "dist", "cli.js"))) return pkg;
  } catch { /* ignore */ }

  // Fallback: scan PATH for pi shim and resolve from there
  const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    const shim = join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
    if (existsSync(shim)) {
      const pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      if (existsSync(join(pkg, "dist", "cli.js"))) return pkg;
    }
  }
  return null;
}

function pruneDir(dir, patterns) {
  for (const pat of patterns) {
    try {
      const matches = execSync(`find "${dir}" -name "${pat}" -type f`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (matches) {
        for (const f of matches.split("\n")) {
          try { rmSync(f); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  // Remove empty dirs left behind
  try {
    execSync(`find "${dir}" -type d -empty -delete`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch { /* ignore */ }
}

function bundlePi() {
  const src = locatePiPackage();
  if (!src) {
    log("ERROR: pi-coding-agent not found. Install it first: npm i -g @earendil-works/pi-coding-agent");
    process.exit(1);
  }
  log(`source pi package: ${src} (${du(src)})`);

  const srcPackage = join(src, "package.json");
  const destPackage = join(PI_OUT, "package.json");
  const srcCli = join(src, "dist", "cli.js");
  const destCli = join(PI_OUT, "dist", "cli.js");
  if (existsSync(destPackage) && existsSync(destCli)) {
    try {
      const srcVersion = JSON.parse(readFileSync(srcPackage, "utf8")).version;
      const destVersion = JSON.parse(readFileSync(destPackage, "utf8")).version;
      const srcCliStat = statSync(srcCli);
      const destCliStat = statSync(destCli);
      if (
        srcVersion === destVersion &&
        srcCliStat.size === destCliStat.size &&
        destCliStat.mtimeMs >= srcCliStat.mtimeMs
      ) {
        log(`pi ${destVersion} already bundled (${du(PI_OUT)}), skipping`);
        return;
      }
    } catch {
      // Fall through to a clean refresh if the existing bundle is incomplete.
    }
  }

  // Clean previous bundle
  if (existsSync(PI_OUT)) rmSync(PI_OUT, { recursive: true, force: true });
  mkdirSync(PI_OUT, { recursive: true });

  // Copy only what's needed at runtime
  log("copying dist/ ...");
  cpSync(join(src, "dist"), join(PI_OUT, "dist"), { recursive: true });

  log("copying node_modules/ ...");
  cpSync(join(src, "node_modules"), join(PI_OUT, "node_modules"), { recursive: true });

  log("copying package.json ...");
  cpSync(join(src, "package.json"), join(PI_OUT, "package.json"));

  // Prune unnecessary files
  log("pruning source maps, type declarations, @types, tests, docs ...");
  pruneDir(PI_OUT, ["*.map", "*.d.ts", "*.d.ts.map", "*.d.mts", "*.d.cts"]);
  // Remove @types entirely (not needed at runtime)
  const typesDir = join(PI_OUT, "node_modules", "@types");
  if (existsSync(typesDir)) rmSync(typesDir, { recursive: true, force: true });
  // Remove test directories
  try {
    execSync(`find "${PI_OUT}" -type d \\( -name "test" -o -name "tests" -o -name "__tests__" -o -name ".github" \\) -exec rm -rf {} + 2>/dev/null || true`, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
  } catch { /* ignore */ }

  log(`pi bundled: ${du(PI_OUT)}`);
}

// --- Main -------------------------------------------------------------------

log("starting ...");
mkdirSync(OUT, { recursive: true });
bundleNode();
bundlePi();
log(`total bundled size: ${du(OUT)}`);
log("done.");
