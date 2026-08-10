import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { getAgentDir, readThreadHistory } from "./session-store";
import { chatCandidates, chatCompletion } from "./git-service";

/**
 * App-side idle recap.
 *
 * omp's own recap feature (recap.enabled / recap.idleSeconds) only runs in the
 * interactive TUI: the recap controller is instantiated exclusively inside
 * InteractiveMode, and `rpc-mode.ts` has zero recap references. In rpc-ui mode
 * (which Omp Studio uses) omp never generates a recap, so this module does it:
 * after a thread's agent settles and stays idle for `idleSeconds`, a short
 * "where things stand" summary is generated via the lightweight chat model and
 * pushed to the renderer as a `custom_message` with customType "recap".
 */

const DEFAULT_IDLE_SECONDS = 240;

/** Read recap.enabled / recap.idleSeconds from omp's config.yml (nested block). */
function readRecapConfig(): { enabled: boolean; idleSeconds: number } {
  const out = { enabled: true, idleSeconds: DEFAULT_IDLE_SECONDS };
  try {
    const file = join(getAgentDir(), "config.yml");
    if (!existsSync(file)) return out;
    const cfg = parseYaml(readFileSync(file, "utf8")) as unknown;
    if (cfg && typeof cfg === "object") {
      const recap = (cfg as Record<string, unknown>).recap;
      if (recap && typeof recap === "object") {
        const block = recap as Record<string, unknown>;
        if (typeof block.enabled === "boolean") out.enabled = block.enabled;
        if (typeof block.idleSeconds === "number" && block.idleSeconds > 0) out.idleSeconds = block.idleSeconds;
      }
    }
  } catch {
    /* keep defaults */
  }
  return out;
}

/** Plain-text projection of a raw pi message (user/assistant only). */
function textOf(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const msg = m as { content?: unknown };
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((b) => {
        if (b && typeof b === "object") {
          const block = b as { type?: unknown; text?: unknown };
          return block.type === "text" && typeof block.text === "string" ? block.text.trim() : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const recapTimers = new Map<string, NodeJS.Timeout>();

export function cancelRecap(threadId: string): void {
  const t = recapTimers.get(threadId);
  if (t) {
    clearTimeout(t);
    recapTimers.delete(threadId);
  }
}

export interface ScheduleRecapOptions {
  threadId: string;
  /** Session .jsonl path; also the stable thread id after open. */
  sessionFile: string;
  bridge: { getState(): Promise<unknown> };
  onRecap: (text: string) => void;
}

export function scheduleRecap(opts: ScheduleRecapOptions): void {
  cancelRecap(opts.threadId);
  const cfg = readRecapConfig();
  if (!cfg.enabled) return;
  const timer = setTimeout(() => {
    recapTimers.delete(opts.threadId);
    void generateRecap(opts);
  }, cfg.idleSeconds * 1000);
  recapTimers.set(opts.threadId, timer);
}

/** Flatten omp's todoPhases into a "phase: task1; task2" listing. */
function todoText(state: unknown): string {
  if (!state || typeof state !== "object") return "";
  const todoPhases = (state as Record<string, unknown>).todoPhases;
  if (!Array.isArray(todoPhases)) return "";
  const lines: string[] = [];
  for (const p of todoPhases) {
    if (!p || typeof p !== "object") continue;
    const phase = p as { name?: unknown; tasks?: unknown };
    const tasks = Array.isArray(phase.tasks)
      ? phase.tasks
          .map((t) => {
            if (t && typeof t === "object") {
              const task = t as { content?: unknown };
              return typeof task.content === "string" ? task.content : "";
            }
            return "";
          })
          .filter(Boolean)
          .join("; ")
      : "";
    lines.push(`${String(phase.name ?? "")}: ${tasks}`.trim());
  }
  return lines.filter(Boolean).join("\n");
}

async function generateRecap(opts: ScheduleRecapOptions): Promise<void> {
  try {
    const history = await readThreadHistory(opts.sessionFile).catch(() => null);
    const messages = history?.messages ?? [];
    const recent = messages
      .slice(-8)
      .map(textOf)
      .filter(Boolean)
      .join("\n")
      .slice(0, 3000);
    let todos = "";
    try {
      todos = todoText(await opts.bridge.getState());
    } catch {
      /* todos are optional context */
    }
    const prompt =
      "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. " +
      "Lead with the overall goal and current task, then the one next action. " +
      "Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.\n\n" +
      `Current todos:\n${todos || "(none)"}\n\nRecent conversation:\n${recent}`;
    const candidates = await chatCandidates();
    if (!candidates.length) {
      console.log("[recap] no direct chat endpoints available; skipping recap");
      return;
    }
    for (const endpoint of candidates) {
      try {
        const text = await chatCompletion(endpoint, prompt, { maxTokens: 100, temperature: 0.3 });
        if (text) {
          console.log(`[recap] generated via=${endpoint.provider}/${endpoint.model} out=${text.length}b`);
          opts.onRecap(text);
          return;
        }
      } catch (e: unknown) {
        console.log(`[recap] ${endpoint.provider}/${endpoint.model} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e: unknown) {
    console.log(`[recap] generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
