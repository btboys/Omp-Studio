import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(`${pathToFileURL(resolve("src/renderer/src/lib/todos.ts")).href}?test=${Date.now()}`);
const { replayTodoOps, groupTodosByPhase, todosFromPhases } = mod;

// init creates the list in order, phase by phase; first pending auto-promotes
assert.deepEqual(
  replayTodoOps([{ op: "init", list: [{ phase: "A", items: ["a1", "a2"] }, { phase: "B", items: ["b1"] }] }]),
  [
    { done: false, text: "a1", phase: "A", status: "in_progress" },
    { done: false, text: "a2", phase: "A", status: "pending" },
    { done: false, text: "b1", phase: "B", status: "pending" },
  ],
  "init must flatten phases and auto-start the first pending item",
);

// start / done by verbatim task text; next pending auto-promotes after done
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] },
    { op: "start", task: "a1" },
    { op: "done", task: "a1" },
  ]),
  [
    { done: true, text: "a1", phase: "A", status: "done" },
    { done: false, text: "a2", phase: "A", status: "in_progress" },
  ],
  "done by task text must mark that item and promote the next pending",
);

// done by phase marks the whole phase
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }, { phase: "B", items: ["b1"] }] },
    { op: "done", phase: "A" },
  ]),
  [
    { done: true, text: "a1", phase: "A", status: "done" },
    { done: true, text: "a2", phase: "A", status: "done" },
    { done: false, text: "b1", phase: "B", status: "in_progress" },
  ],
  "done by phase must mark every item of the phase and promote the next",
);

// append adds pending items; block keeps blocked (not auto-promoted); drop removes one
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1"] }] },
    { op: "append", phase: "A", items: ["a2"] },
    { op: "block", task: "a1" },
    { op: "unblock", task: "a1" },
    { op: "drop", task: "a2" },
  ]),
  [{ done: false, text: "a1", phase: "A", status: "in_progress" }],
  "append/block/unblock/drop must keep the expected item set with auto-promote",
);

// explicit block state survives when another item is already in progress
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] },
    { op: "block", task: "a2" },
  ]),
  [
    { done: false, text: "a1", phase: "A", status: "in_progress" },
    { done: false, text: "a2", phase: "A", status: "blocked" },
  ],
  "block must mark the target blocked without demoting the active item",
);

// rm with no target clears everything; rm with a task removes just it
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1", "a2"] }] },
    { op: "rm", task: "a1" },
  ]),
  [{ done: false, text: "a2", phase: "A", status: "in_progress" }],
  "rm by task must remove just that item and promote the next",
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
    { done: false, text: "x1", status: "in_progress" },
    { done: false, text: "x2", status: "pending" },
  ],
  "init with bare items must create the list and auto-start the first",
);

// init replaces the whole list
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1"] }] },
    { op: "init", list: [{ phase: "B", items: ["b1"] }] },
  ]),
  [{ done: false, text: "b1", phase: "B", status: "in_progress" }],
  "a later init must replace the earlier list",
);

// omitted `op` with list — models routinely send `{list:[...]}` / `{i:"init",list:[...]}`
// and omp infers init; Studio must do the same or the panel stays empty
assert.deepEqual(
  replayTodoOps([
    {
      i: "init",
      list: [
        { phase: "Research", items: ["查库", "查代码"] },
        { phase: "Diagnosis", items: ["查明根因"] },
      ],
    },
    { op: "done", task: "查库" },
  ]),
  [
    { done: true, text: "查库", phase: "Research", status: "done" },
    { done: false, text: "查代码", phase: "Research", status: "in_progress" },
    { done: false, text: "查明根因", phase: "Diagnosis", status: "pending" },
  ],
  "omitted op with list must infer init so later done ops apply",
);

// omitted `op` with bare items and empty state → init
assert.deepEqual(
  replayTodoOps([{ items: ["x1", "x2"] }]),
  [
    { done: false, text: "x1", status: "in_progress" },
    { done: false, text: "x2", status: "pending" },
  ],
  "omitted op with bare items and empty state must infer init",
);

// omitted `op` with items+phase → append
assert.deepEqual(
  replayTodoOps([
    { op: "init", list: [{ phase: "A", items: ["a1"] }] },
    { phase: "A", items: ["a2"] },
  ]),
  [
    { done: false, text: "a1", phase: "A", status: "in_progress" },
    { done: false, text: "a2", phase: "A", status: "pending" },
  ],
  "omitted op with items+phase must infer append",
);

// full-state todos format keeps status mapping
assert.deepEqual(
  replayTodoOps([
    {
      todos: [
        { content: "one", status: "completed", phase: "A" },
        { content: "two", status: "in_progress", phase: "A" },
        { content: "three", status: "blocked", phase: "B" },
      ],
    },
  ]),
  [
    { done: true, text: "one", phase: "A", status: "done" },
    { done: false, text: "two", phase: "A", status: "in_progress" },
    { done: false, text: "three", phase: "B", status: "blocked" },
  ],
  "full-state todos must map status/phase onto panel items",
);

// groupTodosByPhase preserves order and keeps flat lists as one group
assert.deepEqual(
  groupTodosByPhase([
    { done: true, text: "a1", phase: "A", status: "done" },
    { done: false, text: "b1", phase: "B", status: "pending" },
    { done: false, text: "a2", phase: "A", status: "pending" },
  ]),
  [
    {
      phase: "A",
      items: [
        { done: true, text: "a1", phase: "A", status: "done" },
        { done: false, text: "a2", phase: "A", status: "pending" },
      ],
    },
    {
      phase: "B",
      items: [{ done: false, text: "b1", phase: "B", status: "pending" }],
    },
  ],
  "groupTodosByPhase must keep first-seen phase order and collect members",
);


// full-state todos without phase default to "Tasks" (matches omp toolResult details)
assert.deepEqual(
  replayTodoOps([
    {
      todos: [
        { content: "one", status: "in_progress" },
        { content: "two", status: "pending" },
        { content: "three", status: "pending" },
      ],
      merged: false,
    },
  ]),
  [
    { done: false, text: "one", phase: "Tasks", status: "in_progress" },
    { done: false, text: "two", phase: "Tasks", status: "pending" },
    { done: false, text: "three", phase: "Tasks", status: "pending" },
  ],
  "full-state todos without phase must default to Tasks",
);

// todosFromPhases maps toolResult.details.phases (the tree Image 2 expects)
assert.deepEqual(
  todosFromPhases([
    {
      name: "Tasks",
      tasks: [
        { content: "useInvoiceListPage.js: 新增删除关联凭证逻辑", status: "in_progress" },
        { content: "IncomeInvoice/OutputInvoice: 批量操作菜单加入口", status: "pending" },
        { content: "自检与简要验证", status: "pending" },
      ],
    },
  ]),
  [
    { done: false, text: "useInvoiceListPage.js: 新增删除关联凭证逻辑", phase: "Tasks", status: "in_progress" },
    { done: false, text: "IncomeInvoice/OutputInvoice: 批量操作菜单加入口", phase: "Tasks", status: "pending" },
    { done: false, text: "自检与简要验证", phase: "Tasks", status: "pending" },
  ],
  "todosFromPhases must flatten details.phases with status mapping",
);

assert.deepEqual(todosFromPhases(null), [], "todosFromPhases(null) must be empty");
assert.deepEqual(todosFromPhases([]), [], "todosFromPhases([]) must be empty");

assert.deepEqual(
  groupTodosByPhase(
    todosFromPhases([
      {
        name: "Tasks",
        tasks: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "pending" },
        ],
      },
    ]),
  ),
  [
    {
      phase: "Tasks",
      items: [
        { done: false, text: "a", phase: "Tasks", status: "in_progress" },
        { done: false, text: "b", phase: "Tasks", status: "pending" },
      ],
    },
  ],
  "phases from details must group under Tasks for the panel header",
);

console.log("todo replay tests passed");
