import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";
import { getConfig } from "./config";
import { getAgentDir, getSessionsDir } from "./session-store";
import { getOmpVersion, isAppManagedRuntime, resolvePiRuntime, runtimeKind } from "./pi-bridge";
import type { Diagnostics, ModelsFile, ProviderDef, ThinkingDefaults } from "../renderer/src/lib/types";

/**
 * Safe read/write access to omp's `models.yml` (custom providers) and the
 * pi-compat slice of `~/.omp/agent/settings.json` (default provider/model +
 * thinking defaults), plus a diagnostics snapshot for the Settings panel.
 *
 * omp stores custom providers in `~/.omp/agent/models.yml`:
 *   providers:
 *     spark:
 *       baseUrl: http://.../v1
 *       api: openai-completions
 *       apiKey: dummy
 *       models:
 *         - id: minimax-m3
 *           name: MiniMax M3
 *           contextWindow: 100000
 *           maxTokens: 32000
 * and continues to honour pi's settings.json keys (`defaultProvider`,
 * `defaultModel`, `defaultThinkingLevel`, `hideThinkingBlock`).
 *
 * Round-trip safety: we never rebuild these files from a fixed schema. We parse
 * the existing file, mutate only the subtree we own, and write back — so any
 * hand-written advanced fields survive untouched. Writes are atomic (write to a
 * sibling .tmp then rename) so a crash mid-write cannot corrupt the file omp
 * is about to reload.
 */

export function getModelsPath(): string {
  return join(getAgentDir(), "models.yml");
}
/** omp's pi-compat settings file (defaultProvider/defaultModel/thinking). */
export function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}
/** omp's live config (config.yml): role routing incl. `modelRoles.default`. */
export function getConfigYmlPath(): string {
  return join(getAgentDir(), "config.yml");
}
export function getAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

function readText(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseYamlFile<T>(file: string): T | null {
  const text = readText(file);
  if (text == null) return null;
  try {
    const value = parseYaml(text);
    if (value && typeof value === "object") return value as T;
    return null;
  } catch {
    return null;
  }
}

function writeTextAtomic(file: string, text: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function writeYamlAtomic(file: string, data: unknown): void {
  writeTextAtomic(file, dumpYaml(data, { noRefs: true, lineWidth: 120 }));
}

/* ---------------- models.yml (custom providers) ---------------- */

/**
 * omp keeps its live model routing in config.yml `modelRoles` (`role: provider/model[:level]`),
 * separate from models.yml. Merge those provider/model pairs into the models.yml view so the
 * Settings panel and default-provider/model selects reflect the models omp actually runs.
 */
function roleModels(): Record<string, ProviderDef> {
  const out: Record<string, ProviderDef> = {};
  const cfg = parseYamlFile<{ modelRoles?: Record<string, string> }>(getConfigYmlPath());
  const roles = cfg?.modelRoles;
  if (!roles || typeof roles !== "object") return out;
  for (const value of Object.values(roles)) {
    const [provider, rest] = String(value || "").split("/");
    const model = rest?.split(":")[0];
    if (!provider || !model) continue;
    const def = (out[provider] ||= {});
    def.models = def.models || [];
    if (!def.models.some((m) => m.id === model)) {
      def.models.push({ id: model, name: model });
    }
  }
  return out;
}

export function readModelsFile(): ModelsFile {
  const parsed = parseYamlFile<ModelsFile>(getModelsPath());
  const base = parsed && typeof parsed === "object" ? parsed : { providers: {} };
  if (!base.providers || typeof base.providers !== "object") base.providers = {};
  const merged: Record<string, ProviderDef> = { ...roleModels(), ...base.providers };
  for (const [key, def] of Object.entries(roleModels())) {
    const existing = merged[key];
    if (!existing) continue;
    merged[key] = {
      ...def,
      ...existing,
      models: [...(def.models || []), ...(existing.models || [])].filter(
        (m, i, arr) => arr.findIndex((x) => x.id === m.id) === i,
      ),
    };
  }
  return { ...base, providers: merged };
}

/** One parsed `modelRoles.<role>` entry: "provider/model[:level]". */
export interface RoleSelection {
  provider: string;
  model: string;
  level?: string;
}

function parseRoleValue(value: unknown): RoleSelection | null {
  const [provider, rest] = String(value || "").split("/");
  if (!provider || !rest) return null;
  const [model, level] = rest.split(":");
  if (!model) return null;
  return level ? { provider, model, level } : { provider, model };
}

/**
 * omp's scenario routing table: config.yml `modelRoles` (default/smol/slow/
 * vision/plan/designer/commit/tiny/task/advisor). `modelRoles.default` is the
 * new-session model; settings.json `defaultProvider`/`defaultModel` are the
 * legacy pi keys omp no longer routes on.
 */
export function readModelRoles(): Record<string, RoleSelection> {
  const cfg = parseYamlFile<{ modelRoles?: Record<string, unknown> }>(getConfigYmlPath());
  const out: Record<string, RoleSelection> = {};
  for (const [role, value] of Object.entries(cfg?.modelRoles || {})) {
    const parsed = parseRoleValue(value);
    if (parsed) out[role] = parsed;
  }
  return out;
}

/**
 * A fast model for lightweight one-shot generation (commit messages): omp's
 * `smol` role is the explicit lightweight contract, `advisor` is its cheap
 * background role; either beats routing a trivial prompt to a slow default
 * reasoning model. Returns "provider/model" without any `:level` suffix.
 */
export function readLightweightRoleModel(): string | null {
  const cfg = parseYamlFile<{ modelRoles?: Record<string, unknown> }>(getConfigYmlPath());
  const roles = cfg?.modelRoles || {};
  for (const role of ["smol", "advisor"]) {
    const value = String(roles[role] || "");
    const [provider, rest] = value.split("/");
    const model = rest?.split(":")[0];
    if (provider && model) return `${provider}/${model}`;
  }
  return null;
}

export function writeModelRole(
  role: string,
  provider: string,
  model: string | null,
  level?: string | null,
): Record<string, RoleSelection> {
  const existing = parseYamlFile<Record<string, unknown>>(getConfigYmlPath()) || {};
  const roles: Record<string, unknown> =
    existing.modelRoles && typeof existing.modelRoles === "object" ? { ...(existing.modelRoles as Record<string, unknown>) } : {};
  if (!model) delete roles[role];
  else roles[role] = `${provider}/${model}${level ? `:${level}` : ""}`;
  writeYamlAtomic(getConfigYmlPath(), { ...existing, modelRoles: roles });
  return readModelRoles();
}

/**
 * Replace the `providers` subtree while preserving any other top-level keys the
 * user may have added by hand. `providers` is the renderer's edited copy; each
 * provider/model object inside it is written verbatim (unknown fields included).
 */
export function writeModelsProviders(providers: Record<string, ProviderDef>): ModelsFile {
  const existing = parseYamlFile<Record<string, unknown>>(getModelsPath()) || {};
  const next: Record<string, unknown> = { ...existing, providers: providers || {} };
  writeYamlAtomic(getModelsPath(), next);
  return next as ModelsFile;
}

export interface ModelAvailabilityResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

const MODEL_TEST_TIMEOUT_MS = 120_000;

function conciseModelTestError(stdout: string, stderr: string, fallback: string, secret?: string): string {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      const message =
        value?.message?.errorMessage ||
        value?.error?.message ||
        value?.error ||
        (value?.type === "error" ? value?.message : undefined);
      if (typeof message === "string" && message.trim()) candidates.push(message.trim());
    } catch {
      // JSON output may contain non-event startup lines; stderr is checked next.
    }
  }
  const stderrText = stderr.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (stderrText) candidates.push(stderrText.split(/\r?\n/).filter(Boolean).slice(-3).join(" "));
  candidates.push(fallback);
  let message = candidates.find((value) => value.trim()) || "Model request failed.";
  if (secret && !secret.startsWith("$") && !secret.startsWith("!")) message = message.split(secret).join("[redacted]");
  return message.length > 600 ? message.slice(0, 597) + "..." : message;
}

/**
 * Run a real, minimal inference against an edited provider/model definition.
 * The isolated agent directory lets unsaved Settings changes be tested without
 * modifying the user's models.yml/config.yml or creating a thread/session.
 */
export async function testModelAvailability(
  providerId: string,
  provider: ProviderDef,
  modelId: string,
): Promise<ModelAvailabilityResult> {
  const started = Date.now();
  const testDir = mkdtempSync(join(tmpdir(), "pi-studio-model-test-"));
  try {
    const targetModel = (provider.models || []).find((model) => model.id === modelId);
    // Some reasoning-only gateways reject enable_thinking=false outright.
    // Keep the test cheap with the lowest supported level, but do not send an
    // invalid "off" request for models explicitly configured for reasoning.
    const testThinkingLevel = targetModel?.reasoning ? "minimal" : "off";
    writeYamlAtomic(join(testDir, "models.yml"), { providers: { [providerId]: provider } });
    const authPath = getAuthPath();
    if (existsSync(authPath)) copyFileSync(authPath, join(testDir, "auth.json"));
    const runtime = await resolvePiRuntime(getConfig().ompBinPath);
    const args = [
      "--mode",
      "json",
      "--print",
      "--model",
      `${providerId}/${modelId}`,
      "--thinking",
      testThinkingLevel,
      "--system-prompt",
      "You are a connectivity probe. Do not reason. Reply only with ok.",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "测试连通性，不要思考，回复我ok即可",
    ];
    return await new Promise<ModelAvailabilityResult>((resolve) => {
      const child = spawn(runtime.bin, args, {
        cwd: testDir,
        windowsHide: true,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: testDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutBuffer = "";
      let stdoutTail = "";
      let stderr = "";
      let result: ModelAvailabilityResult | null = null;
      let resolved = false;

      const settleOnExit = (next: ModelAvailabilityResult, stopEarly = false) => {
        if (result) return;
        result = next;
        clearTimeout(timeout);
        if (stopEarly && !child.killed) child.kill();
      };
      const finish = (next: ModelAvailabilityResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(next);
      };
      const success = () =>
        settleOnExit(
          {
            ok: true,
            latencyMs: Date.now() - started,
            message: "Model started responding successfully.",
          },
          true,
        );
      const failure = (message: string, stopEarly = false) =>
        settleOnExit(
          {
            ok: false,
            latencyMs: Date.now() - started,
            message: conciseModelTestError(stdoutTail, stderr, message, provider.apiKey),
          },
          stopEarly,
        );

      const inspectEvent = (line: string) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.type === "message_update") {
          const update = event.assistantMessageEvent;
          if ((update?.type === "text_delta" || update?.type === "thinking_delta") && update.delta) success();
          return;
        }
        if (event?.type === "message_end" && event.message?.role === "assistant") {
          if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            failure(event.message.errorMessage || `Request ${event.message.stopReason}`, true);
          } else {
            success();
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutTail = (stdoutTail + text).slice(-32 * 1024);
        stdoutBuffer += text;
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line) inspectEvent(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-32 * 1024);
      });
      child.on("error", (error) => {
        finish({
          ok: false,
          latencyMs: Date.now() - started,
          message: conciseModelTestError(stdoutTail, stderr, error.message, provider.apiKey),
        });
      });
      child.on("close", (code) => {
        if (stdoutBuffer.trim()) inspectEvent(stdoutBuffer.trim());
        if (result) {
          finish(result);
          return;
        }
        finish({
          ok: false,
          latencyMs: Date.now() - started,
          message: conciseModelTestError(
            stdoutTail,
            stderr,
            code === 0 ? "The model process exited without producing a response." : `Model test process exited with code ${code}.`,
            provider.apiKey,
          ),
        });
      });

      const timeout = setTimeout(() => {
        failure("The model did not start responding within 120 seconds.", true);
      }, MODEL_TEST_TIMEOUT_MS);
    });
  } catch (error: any) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: conciseModelTestError("", "", error?.message || String(error), provider.apiKey),
    };
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

/* ---------------- settings.json (thinking slice) ---------------- */
/**
 * omp inherits pi's settings.json keys (`defaultProvider`, `defaultModel`,
 * `defaultThinkingLevel`, `hideThinkingBlock`) — the user's own
 * `~/.omp/agent/settings.json` carries `defaultProvider`/`defaultModel`, so
 * the original file and keys are the right surface. config.yml holds omp's
 * newer role routing (`modelRoles`); we leave that to omp.
 */

const THINK_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "hideThinkingBlock"] as const;

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readThinking(): ThinkingDefaults {
  const parsed = readJson<Record<string, unknown>>(getSettingsPath()) || {};
  const out: ThinkingDefaults = {};
  for (const k of THINK_KEYS) {
    if (parsed[k] !== undefined) (out as any)[k] = parsed[k];
  }
  return out;
}

/**
 * Merge a partial patch into settings.json. `undefined` values are skipped (keep
 * current); any other value (including `null`/`""`) is written as-is so the user
 * can clear a default by setting it to an empty string.
 */
export function writeThinking(patch: Partial<ThinkingDefaults>): ThinkingDefaults {
  const parsed = readJson<Record<string, unknown>>(getSettingsPath()) || {};
  const next: Record<string, unknown> = { ...parsed };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === "") delete next[k];
    else next[k] = v;
  }
  writeTextAtomic(getSettingsPath(), JSON.stringify(next, null, 2) + "\n");
  return readThinking();
}

/* ---------------- diagnostics ---------------- */

export async function getDiagnostics(): Promise<Diagnostics> {
  const agentDir = getAgentDir();
  const sessionsDir = getSessionsDir();
  const settingsPath = getSettingsPath();
  const authPath = getAuthPath();
  const modelsPath = getModelsPath();
  const base: Diagnostics = {
    bin: null,
    ompVersion: null,
    agentDir,
    sessionsDir,
    settingsPath,
    authPath,
    modelsPath,
    settingsExists: existsSync(settingsPath),
    authExists: existsSync(authPath),
    modelsExists: existsSync(modelsPath),
    runtimeKind: "unknown",
    bundled: false,
    error: null,
  };
  try {
    const rt = await resolvePiRuntime();
    base.bin = rt.bin;
    base.ompVersion = await getOmpVersion(rt.bin);
    // Must be read AFTER resolution: the kind is only known once cached.
    base.runtimeKind = runtimeKind() || "unknown";
    base.bundled = isAppManagedRuntime();
  } catch (e: any) {
    base.error = e?.message || String(e);
  }
  return base;
}
