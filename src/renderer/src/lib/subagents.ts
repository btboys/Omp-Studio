/**
 * Pure helpers for the subagent panel: parsing omp's `task` tool call batch
 * (tasks[] + intent) and deriving per-task status from the live progress
 * snapshots / async-result notices. No React or store dependencies — kept
 * pure so scripts/test-subagents.mjs can assert them directly.
 */

export interface TaskItem {
  name?: string;
  agent?: string;
}

/** The minimal shape of a tool run the subagent panel relies on. */
export interface TaskRunShape {
  args?: unknown;
  argsStr?: string;
  intent?: string;
  running?: boolean;
  completed?: boolean;
  isError?: boolean;
  progress?: { id: string; status: string }[];
}

export interface TaskBatch {
  tasks: TaskItem[];
  i: string;
}

/** Narrow omp's `task` tool payload (tasks[] batch + intent) without casts. */
export function taskArgsOf(raw: unknown): TaskBatch {
  if (!raw || typeof raw !== "object") return { tasks: [], i: "" };
  const tasks: TaskItem[] = [];
  if ("tasks" in raw && Array.isArray(raw.tasks)) {
    for (const t of raw.tasks) {
      if (!t || typeof t !== "object") continue;
      if (!("name" in t) && !("agent" in t)) continue;
      tasks.push({
        name: "name" in t && typeof t.name === "string" ? t.name : undefined,
        agent: "agent" in t && typeof t.agent === "string" ? t.agent : undefined,
      });
    }
  }
  const i = "i" in raw && typeof raw.i === "string" ? raw.i : "";
  return { tasks, i };
}

/** Resolve a `task` tool call's batch from every source that may carry it:
 *  block args (stream-parse), execution event args, or the raw JSON string —
 *  falling back to the call's intent. */
export function taskBatchOf(blockArgs: unknown, run: TaskRunShape): TaskBatch {
  const fromBlock = taskArgsOf(blockArgs);
  if (fromBlock.tasks.length) return fromBlock;
  if (run.args && typeof run.args === "object") {
    const fromRun = taskArgsOf(run.args);
    if (fromRun.tasks.length) return fromRun;
  }
  if (run.argsStr) {
    try {
      const fromStr = taskArgsOf(JSON.parse(run.argsStr));
      if (fromStr.tasks.length) return fromStr;
    } catch {
      /* still streaming / malformed — keep falling back */
    }
  }
  return { tasks: [], i: fromBlock.i || (typeof run.args === "object" ? taskArgsOf(run.args).i : "") || run.intent || "" };
}

export type SubagentRowState = "running" | "done" | "error" | "pending";

/** Per-task status: prefer the live progress snapshot streamed by omp for
 *  `task` batch agents (matched by job id == task name), so rows keep
 *  spinning until each agent's async-result arrives; fall back to the shared
 *  tool run state for non-batch calls. */
export function subagentRowState(name: string, run: TaskRunShape): SubagentRowState {
  const p = run.progress?.find((x) => x.id && x.id === name);
  if (p) {
    if (p.status === "completed") return "done";
    if (p.status === "running" || p.status === "pending") return "running";
  }
  if (run.isError) return "error";
  if (run.completed) return "done";
  if (run.running) return "running";
  return "pending";
}

/** Mark background subagents as completed when omp delivers their async-result
 *  notice (`details.jobs[].jobId` matching a run's progress entry). Returns a
 *  new runs map when anything changed, otherwise null. */
export function applyAsyncJobs<T extends TaskRunShape>(runs: Record<string, T>, jobs: unknown): Record<string, T> | null {
  if (!Array.isArray(jobs) || !jobs.length) return null;
  const jobIds = new Set<string>();
  for (const j of jobs) if (j && typeof j.jobId === "string") jobIds.add(j.jobId);
  if (!jobIds.size) return null;
  let changed = false;
  const next: Record<string, T> = { ...runs };
  for (const key of Object.keys(next)) {
    const r = next[key];
    const progress = r.progress;
    if (!progress || !progress.some((p) => p.id && jobIds.has(p.id))) continue;
    const updated = progress.map((p) => (p.id && jobIds.has(p.id) && p.status !== "completed" ? { ...p, status: "completed" } : p));
    if (updated.some((p, i) => p !== progress[i])) {
      next[key] = { ...r, progress: updated };
      changed = true;
    }
  }
  return changed ? next : null;
}
