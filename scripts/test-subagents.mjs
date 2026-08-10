import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(`${pathToFileURL(resolve("src/renderer/src/lib/subagents.ts")).href}?test=${Date.now()}`);
const { taskArgsOf, taskBatchOf, subagentRowState, applyAsyncJobs } = mod;

const BATCH = {
  i: "Dispatching two scout probes",
  context: "# Goal",
  tasks: [
    { name: "ScoutDomain", agent: "scout", task: "read-only" },
    { name: "ScoutService", agent: "scout", task: "read-only" },
  ],
};

// taskArgsOf parses the tasks[] batch and intent
assert.deepEqual(taskArgsOf(BATCH), { tasks: BATCH.tasks.map(({ name, agent }) => ({ name, agent })), i: "Dispatching two scout probes" }, "batch args must yield tasks + intent");
assert.deepEqual(taskArgsOf({}), { tasks: [], i: "" }, "empty args must yield nothing");
assert.deepEqual(taskArgsOf("not-an-object"), { tasks: [], i: "" }, "non-object args must yield nothing");

// taskBatchOf: block args win when present
assert.deepEqual(
  taskBatchOf(BATCH, { args: { tasks: [{ name: "Other" }] } }),
  { tasks: BATCH.tasks.map(({ name, agent }) => ({ name, agent })), i: "Dispatching two scout probes" },
  "block args are the primary source",
);

// degraded path: block args empty (toolcall_end never parsed) -> run.args from tool_execution_start
assert.deepEqual(
  taskBatchOf({}, { args: BATCH }),
  { tasks: BATCH.tasks.map(({ name, agent }) => ({ name, agent })), i: "Dispatching two scout probes" },
  "empty block args must fall back to execution args",
);

// degraded path: raw JSON string still streaming
assert.deepEqual(
  taskBatchOf({}, { argsStr: JSON.stringify(BATCH) }),
  { tasks: BATCH.tasks.map(({ name, agent }) => ({ name, agent })), i: "Dispatching two scout probes" },
  "empty args must fall back to the raw JSON string",
);

// last resort: batch intent, never a bare "task"
assert.deepEqual(taskBatchOf({}, { intent: "single probe" }), { tasks: [], i: "single probe" }, "intent must be the final fallback name");

// per-task status: live progress snapshot wins over the shared run state
const runRunning = { running: false, completed: true, progress: [{ id: "ScoutDomain", status: "running" }, { id: "ScoutService", status: "pending" }] };
assert.equal(subagentRowState("ScoutDomain", runRunning), "running", "running progress must keep the row spinning even after batch spawn completed");
assert.equal(subagentRowState("ScoutService", runRunning), "running", "pending progress must render as running");

// async-result flips exactly the finished job to done; the other stays running
const afterAlpha = applyAsyncJobs({ task: runRunning }, [{ jobId: "ScoutDomain", type: "task", label: "ScoutDomain" }]);
assert.ok(afterAlpha, "matching async-result must change the runs map");
assert.equal(subagentRowState("ScoutDomain", afterAlpha.task), "done", "completed job must show done");
assert.equal(subagentRowState("ScoutService", afterAlpha.task), "running", "unfinished job must keep running");

// unmatched jobs change nothing
assert.equal(applyAsyncJobs({ task: runRunning }, [{ jobId: "OtherAgent" }]), null, "unmatched async-result must be a no-op");
assert.equal(applyAsyncJobs({ task: runRunning }, "not-array"), null, "malformed jobs must be a no-op");

// shared run fallback for non-batch calls
assert.equal(subagentRowState("", { running: true }), "running", "shared running state must apply when no progress entry matches");
assert.equal(subagentRowState("", { running: false, completed: true }), "done", "shared completed state must apply when no progress entry matches");
assert.equal(subagentRowState("", { running: true, isError: true }), "error", "error must win over running");
assert.equal(subagentRowState("", {}), "pending", "unknown state must render pending");

console.log("subagent panel logic tests passed");
