/** One todo item shown in the todo panel. */
export interface TodoItem {
  done: boolean;
  text: string;
}

/** Args of one `todo` tool call (op + payload). */
export interface TodoOp {
  op: string;
  phase?: string;
  task?: string;
  items?: string[];
  list?: { phase: string; items: string[] }[];
}

/** Replayed state of a single todo item. */
interface TodoItemState {
  phase: string;
  text: string;
  state: "pending" | "in_progress" | "done" | "blocked";
}

/**
 * Replay a session's `todo` tool calls in order to reconstruct the current
 * list. omp's todo tool is stateful (init/start/done/drop/block/unblock/rm/
 * append/view), and each toolCall block only carries one op's payload, so the
 * panel state must be derived by replay rather than from a single message.
 */
export function replayTodoOps(ops: TodoOp[]): TodoItem[] {
  const items: TodoItemState[] = [];
  const findTask = (task: string | undefined) => (task ? items.find((it) => it.text === task) : undefined);
  const removeMatching = (op: { task?: string; phase?: string }) => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].text === op.task || items[i].phase === op.phase) items.splice(i, 1);
    }
  };
  for (const op of ops) {
    switch (op.op) {
      case "init":
        items.length = 0;
        if (op.list) {
          for (const group of op.list) {
            for (const text of group.items || []) items.push({ phase: group.phase, text, state: "pending" });
          }
        } else {
          // Flat single-phase form: `init` with a bare `items` list.
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
        if (op.phase) {
          for (const it of items) if (it.phase === op.phase) it.state = "done";
        } else {
          const target = findTask(op.task);
          if (target) target.state = "done";
        }
        break;
      case "start": {
        const target = findTask(op.task);
        if (target) target.state = "in_progress";
        break;
      }
      case "block": {
        const target = findTask(op.task);
        if (target) target.state = "blocked";
        break;
      }
      case "unblock": {
        const target = findTask(op.task);
        if (target) target.state = "pending";
        break;
      }
      // "view" and unknown ops carry no state change.
    }
  }
  return items.map((it) => ({ done: it.state === "done", text: it.text }));
}
