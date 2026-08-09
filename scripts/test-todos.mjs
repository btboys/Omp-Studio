import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(`${pathToFileURL(resolve("src/renderer/src/lib/todos.ts")).href}?test=${Date.now()}`);
const { replayTodoOps } = mod;

// init creates the list in order, phase by phase
assert.deepEqual(
  replayTodoOps([{ op: "init", list: [{ phase: "A", items: ["a1", "a2"] }, { phase: "B", items: ["b1"] }] }]),
  [
    { done: false, text: "a1" },
    { done: false, text: "a2" },
    { done: false, text: "b1" },
  ],
  "init must flatten phases in order",
);

// start / done by verbatim task text
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] },
    { op: "start", task: "a1" },
    { op: "done", task: "a1" },
  ]),
  [
    { done: true, text: "a1" },
    { done: false, text: "a2" },
  ],
  "done by task text must mark exactly that item",
);

// done by phase marks the whole phase
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] },
    { op: "done", phase: "A" },
  ]),
  [
    { done: true, text: "a1" },
    { done: true, text: "a2" },
  ],
  "done by phase must mark every item of the phase",
);

// append adds pending items; block/unblock keep them pending; drop removes one
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1"] }] },
    { op: "append", phase: "A", items: ["a2"] },
    { op: "block", task: "a1" },
    { op: "unblock", task: "a1" },
    { op: "drop", task: "a2" },
  ]),
  [{ done: false, text: "a1" }],
  "append/block/unblock/drop must keep the expected item set",
);

// rm with no target clears everything; rm with a task removes just it
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] },
    { op: "rm", task: "a1" },
  ]),
  [{ done: false, text: "a2" }],
  "rm by task must remove just that item",
);
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1"] }] },
    { op: "rm" },
  ]),
  [],
  "rm without a target must clear the list",
);

// flat single-phase init form
assert.deepEqual(
  replayTodoOps([{ op: "init", items: ["x1", "x2"] }]),
  [
    { done: false, text: "x1" },
    { done: false, text: "x2" },
  ],
  "init with bare items must create the list",
);

// init replaces the whole list
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1"] }] },
    { op: "init", list: [{ phase: "B", items: ["b1"] }] },
  ]),
  [{ done: false, text: "b1" }],
  "a later init must replace the earlier list",
);

console.log("todo replay tests passed");
