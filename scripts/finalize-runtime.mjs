#!/usr/bin/env node
/** Copy the embedded runtime asset next to the Electron artifacts for QA. */

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(ROOT, "resources", "runtime-manifest.json");
if (!existsSync(manifestPath)) throw new Error("runtime manifest is missing; run npm run bundle first");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const source = join(ROOT, "runtime-release", manifest.fileName);
if (!existsSync(source)) throw new Error(`runtime archive is missing: ${source}`);

const releaseDir = join(ROOT, "release");
mkdirSync(releaseDir, { recursive: true });
cpSync(source, join(releaseDir, manifest.fileName));
cpSync(manifestPath, join(releaseDir, "Omp-Studio-Runtime-manifest.json"));
console.log(`[finalize-runtime] copied ${manifest.fileName} and Omp-Studio-Runtime-manifest.json to ${releaseDir}`);
