import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import gateSource from "./permission-gate-ext.ts?raw";

/**
 * Pi has no built-in sandbox or approval modes (see pi docs/security.md:
 * "No Built-in Sandbox"). The idiomatic way to gate sensitive operations is an
 * extension that hooks the `tool_call` event and confirms dangerous shell
 * commands via `ctx.ui.select` — which surfaces in Pi Studio as the existing
 * extension-UI modal.
 *
 * The gate extension lives as a real source file (permission-gate-ext.ts) and
 * is bundled into the main process as a raw string. At runtime we write it into
 * the userData dir and load it for EVERY thread via `pi --extension <path>`.
 * Whether a thread actually gates is decided at runtime by a small per-thread
 * mode file ("sandbox" | "full") that the extension reads on each bash call, so
 * the permission level can be flipped live without restarting the pi process.
 */
let cachedPath: string | null = null;
let cachedGateDir: string | null = null;

/** Write the gate extension into userData (once) and return its absolute path. */
export function ensureGateExtension(userDataDir: string): string {
  if (cachedPath) return cachedPath;
  const file = join(userDataDir, "pi-studio-permission-gate.ts");
  writeFileSync(file, gateSource, "utf8");
  cachedPath = file;
  return file;
}

function gateDir(userDataDir: string): string {
  if (cachedGateDir) return cachedGateDir;
  cachedGateDir = join(userDataDir, "pi-studio-gates");
  mkdirSync(cachedGateDir, { recursive: true });
  return cachedGateDir;
}

/** Create a per-thread gate mode file holding the initial permission level and
 * return its absolute path (passed to the pi process as PI_STUDIO_GATE_MODE_FILE). */
export function createGateModeFile(userDataDir: string, permission: string): string {
  const file = join(gateDir(userDataDir), `${randomUUID()}.mode`);
  writeFileSync(file, permission, "utf8");
  return file;
}

/** Flip a thread's gate mode live (no process restart). */
export function writeGateMode(file: string, permission: string): void {
  try {
    writeFileSync(file, permission, "utf8");
  } catch {
    /* ignore */
  }
}

/** Delete a thread's gate mode file once its bridge exits. */
export function removeGateModeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}
