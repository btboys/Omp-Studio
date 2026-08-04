import { getConfig, getConfigDir, updateConfig, type AutomationTask, type TaskSchedule } from "./config";
import { PiBridge } from "./pi-bridge";
import { createGateModeFile, ensureGateExtension, removeGateModeFile } from "./permission-gate";

/**
 * Scheduled automation. Tasks are user-defined prompts (which may invoke
 * skills) run in a chosen working folder on an hourly/daily/weekly schedule.
 *
 * The scheduler lives in the main process and only runs while Pi Studio is
 * open. Each fire spawns a fresh pi session in the task's folder, sends the
 * prompt, and waits for `agent_settled`. pi persists the session automatically,
 * so the result appears in the sidebar as a normal, reviewable thread.
 *
 * Tasks default to sandbox. Since unattended jobs cannot answer approval
 * prompts, a sandbox task fails closed when a gated operation is attempted.
 * Full permission must be selected explicitly per task.
 */

export interface AutomationNotify {
  type: "start" | "done";
  taskId: string;
  name: string;
  ok?: boolean;
  error?: string;
}

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
const running = new Set<string>();
let notify: ((p: AutomationNotify) => void) | null = null;

const pad = (n: number) => String(n).padStart(2, "0");

function matches(schedule: TaskSchedule, d: Date): boolean {
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (schedule.frequency === "hourly") return d.getMinutes() === (schedule.minute ?? 0);
  if (schedule.frequency === "daily") return hhmm === (schedule.time || "00:00");
  if (schedule.frequency === "weekly") return (schedule.days || []).includes(d.getDay()) && hhmm === (schedule.time || "00:00");
  return false;
}

/** A dedup key for the current slot so a task fires at most once per slot. */
function slotKey(schedule: TaskSchedule, d: Date): string {
  const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (schedule.frequency === "hourly") return `${day}-h${d.getHours()}`;
  return day; // daily / weekly: once per calendar day
}

function persist(tasks: AutomationTask[]): void {
  updateConfig({ automationTasks: tasks });
}

function patchTask(id: string, patch: Partial<AutomationTask>): void {
  persist(getConfig().automationTasks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

function tick(): void {
  const now = new Date();
  for (const task of getConfig().automationTasks) {
    if (!task.enabled || running.has(task.id)) continue;
    if (!matches(task.schedule, now)) continue;
    const slot = slotKey(task.schedule, now);
    if (task.lastRunSlot === slot) continue;
    // Claim the slot before awaiting so a re-entrant tick can't double-fire.
    patchTask(task.id, { lastRunSlot: slot, lastRunAt: now.getTime() });
    void execute(task);
  }
}

export function startScheduler(send: (p: AutomationNotify) => void): void {
  notify = send;
  if (timer) return;
  timer = setInterval(tick, 20_000);
  bootTimer = setTimeout(tick, 4_000);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
}

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

async function execute(task: AutomationTask): Promise<void> {
  running.add(task.id);
  notify?.({ type: "start", taskId: task.id, name: task.name });
  let bridge: PiBridge | null = null;
  let gateModeFile: string | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => finish(() => reject(new Error("运行超时（30 分钟）"))), RUN_TIMEOUT_MS);

      const permission = task.permission === "full" ? "full" : "sandbox";
      gateModeFile = createGateModeFile(getConfigDir(), permission);
      bridge = new PiBridge({
        cwd: task.cwd,
        piCliPath: getConfig().piCliPath,
        extensions: [ensureGateExtension(getConfigDir())],
        gateModeFile,
        name: `自动化: ${task.name}`,
        onEvent: (e: any) => {
          if (e?.type === "agent_settled") finish(() => resolve());
        },
        onExtUi: (r: any) => {
          // Unattended run: cancel any dialog immediately so the task never hangs.
          bridge?.respondExtUi(r.id, { cancelled: true });
        },
        onExit: (info) => finish(() => (info.code === 0 ? resolve() : reject(new Error(`pi 退出（code ${info.code}）`)))),
        onError: (err) => finish(() => reject(err)),
      });

      bridge
        .start()
        .then(() => bridge!.prompt(task.prompt))
        .catch((e) => finish(() => reject(e)));
    });
    patchTask(task.id, { lastStatus: "ok", lastError: undefined });
    notify?.({ type: "done", taskId: task.id, name: task.name, ok: true });
  } catch (e: any) {
    const msg = e?.message || String(e);
    patchTask(task.id, { lastStatus: "error", lastError: msg });
    notify?.({ type: "done", taskId: task.id, name: task.name, ok: false, error: msg });
  } finally {
    const b = bridge as PiBridge | null;
    try {
      b?.stop();
    } catch {
      /* ignore */
    }
    if (gateModeFile) removeGateModeFile(gateModeFile);
    running.delete(task.id);
  }
}

/** Run a task immediately (the "Run now" button), bypassing the schedule. */
export async function runTaskNow(id: string): Promise<void> {
  const task = getConfig().automationTasks.find((t) => t.id === id);
  if (!task) throw new Error("Task not found");
  if (running.has(id)) return;
  patchTask(id, { lastRunAt: Date.now() });
  await execute(task);
}
