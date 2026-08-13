/** Status of one todo item shown in the panel. */
export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

/** One todo item shown in the todo panel. */
export interface TodoItem {
  /** Convenience mirror of `status === "done"` for callers that only care about completion. */
  done: boolean;
  text: string;
  /** Phase name when present (empty / omitted for flat lists and markdown checkboxes). */
  phase?: string;
  status: TodoStatus;
}

/** A phase group for panel rendering. */
export interface TodoPhaseGroup {
  phase: string;
  items: TodoItem[];
}

/** Args of one `todo` tool call — either legacy op-based or new full-state. */
export interface TodoOp {
  op?: string;
  phase?: string;
  task?: string;
  items?: string[];
  list?: { phase: string; items: string[] }[];
  /** New omp format: full-state replacement per call. */
  todos?: { content: string; status: string; phase?: string }[];
  merged?: boolean;
}

/** Operation names accepted by omp's todo tool. */
type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";

/** Replayed state of a single todo item. */
interface TodoItemState {
  phase: string;
  text: string;
  state: TodoStatus;
}

/**
 * Infer a missing `op` from the raw argument shape. Mirrors omp's
 * `inferTodoOp`: models routinely send `{list:[...]}` (or bare `items`)
 * without `op`, and omp repairs that at execute time. Studio must do the
 * same when replaying stored tool-call args, or the panel stays empty.
 *
 * Only unambiguous shapes are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append`
 * - bare `items` with no existing todos → `init`
 */
export function inferTodoOp(op: TodoOp, hasExistingItems: boolean): TodoOperation | undefined {
  if (Array.isArray(op.list) && op.list.length > 0) return "init";
  if (Array.isArray(op.items) && op.items.length > 0) {
    if (typeof op.phase === "string" && op.phase) return "append";
    if (!hasExistingItems) return "init";
  }
  return undefined;
}

/** Map an omp / full-state status string onto the panel's four statuses. */
function mapTodoStatus(raw: string | undefined): TodoStatus {
  switch ((raw || "").toLowerCase()) {
    case "completed":
    case "done":
    case "abandoned":
      return "done";
    case "in_progress":
    case "in-progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
}

/**
 * Mirror omp's `normalizeInProgressTask`: at most one in_progress item, and
 * when none is set, auto-promote the first pending task. Without this, the
 * panel stays all-pending after init even though omp already marked the first
 * open task as in progress.
 */
function normalizeInProgress(items: TodoItemState[]): void {
  if (items.length === 0) return;
  const inProgress = items.filter((it) => it.state === "in_progress");
  if (inProgress.length > 1) {
    for (const it of inProgress.slice(1)) it.state = "pending";
  }
  if (inProgress.length > 0) return;
  const firstPending = items.find((it) => it.state === "pending");
  if (firstPending) firstPending.state = "in_progress";
}

function toTodoItem(it: TodoItemState): TodoItem {
  const item: TodoItem = {
    done: it.state === "done",
    text: it.text,
    status: it.state,
  };
  if (it.phase) item.phase = it.phase;
  return item;
}

/**
 * Group items by phase, preserving first-seen phase order. Items without a
 * phase land in a single trailing "" group so flat lists still render as one
 * contiguous block.
 */
export function groupTodosByPhase(items: TodoItem[]): TodoPhaseGroup[] {
  const order: string[] = [];
  const map = new Map<string, TodoItem[]>();
  for (const it of items) {
    const phase = it.phase || "";
    if (!map.has(phase)) {
      map.set(phase, []);
      order.push(phase);
    }
    map.get(phase)!.push(it);
  }
  return order.map((phase) => ({ phase, items: map.get(phase)! }));
}

/**
 * Convert omp todo toolResult `details.phases` into panel items. This is the
 * richest source: tool call args often omit `phase`, while the result details
 * always carry the phase tree (e.g. "Tasks") that the panel should show.
 */
export function todosFromPhases(
  phases: { name?: string; tasks?: { content?: string; status?: string }[] }[] | null | undefined,
): TodoItem[] {
  if (!Array.isArray(phases) || phases.length === 0) return [];
  const items: TodoItem[] = [];
  for (const phase of phases) {
    const phaseName = typeof phase?.name === "string" ? phase.name : "";
    for (const task of phase?.tasks || []) {
      const status = mapTodoStatus(task?.status);
      const item: TodoItem = {
        done: status === "done",
        text: task?.content || "",
        status,
      };
      if (phaseName) item.phase = phaseName;
      items.push(item);
    }
  }
  return items;
}

/**
 * Replay a session's `todo` tool calls in order to reconstruct the current
 * list. omp's todo tool is stateful (init/start/done/drop/block/unblock/rm/
 * append/view), and each toolCall block only carries one op's payload, so the
 * panel state must be derived by replay rather than from a single message.
 */
export function replayTodoOps(ops: TodoOp[]): TodoItem[] {
  // --- New omp format: each call carries the full list in `todos`. ---
  // Walk forward; last call with `todos` wins (full-state replacement).
  let latestTodos: { content: string; status: string; phase?: string }[] | null = null;
  for (const op of ops) {
    if (Array.isArray(op.todos)) latestTodos = op.todos;
  }
  if (latestTodos) {
    return latestTodos.map((t) => {
      const status = mapTodoStatus(t.status);
      // omp stores Cursor-style full-state todos under phase "Tasks" even when
      // the tool-call args omit `phase`. Default so the panel matches the
      // toolResult details tree (e.g. "Tasks · 0/3").
      const phase = t.phase || "Tasks";
      return {
        done: status === "done",
        text: t.content || "",
        status,
        phase,
      };
    });
  }

  // --- Legacy op-based format (init/start/done/drop/…). ---
  const items: TodoItemState[] = [];
  const findTask = (task: string | undefined) => (task ? items.find((it) => it.text === task) : undefined);
  const removeMatching = (op: { task?: string; phase?: string }) => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].text === op.task || items[i].phase === op.phase) items.splice(i, 1);
    }
  };
  const setState = (op: { task?: string; phase?: string }, state: TodoStatus) => {
    if (op.phase) {
      for (const it of items) if (it.phase === op.phase) it.state = state;
      return;
    }
    const target = findTask(op.task);
    if (target) target.state = state;
  };
  for (const raw of ops) {
    const resolvedOp = (raw.op || inferTodoOp(raw, items.length > 0)) as TodoOperation | undefined;
    if (!resolvedOp) continue;
    const op = { ...raw, op: resolvedOp };
    switch (op.op) {
      case "init":
        items.length = 0;
        if (op.list) {
          for (const group of op.list) {
            for (const text of group.items || []) items.push({ phase: group.phase, text, state: "pending" });
          }
        } else {
          for (const text of op.items || []) items.push({ phase: "", text, state: "pending" });
        }
        break;
      case "append":
        for (const text of op.items || []) items.push({ phase: op.phase || "", text, state: "pending" });
        break;
      case "rm":
        if (op.task || op.phase) removeMatching(op);
        else items.length = 0;
        break;
      case "drop":
        removeMatching(op);
        break;
      case "done":
        setState(op, "done");
        break;
      case "start":
        setState(op, "in_progress");
        break;
      case "block":
        setState(op, "blocked");
        break;
      case "unblock":
        setState(op, "pending");
        break;
    }
    // Match omp: after every mutating op, ensure exactly one in_progress
    // (or auto-promote the first pending). view is a no-op above.
    if (op.op !== "view") normalizeInProgress(items);
  }
  return items.map(toTodoItem);
}
