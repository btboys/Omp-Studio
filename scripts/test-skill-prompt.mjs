import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!globalThis.localStorage) {
  const mem = Object.create(null);
  globalThis.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => {
      mem[k] = String(v);
    },
    removeItem: (k) => {
      delete mem[k];
    },
  };
}
if (!globalThis.window) {
  globalThis.window = { localStorage: globalThis.localStorage, pi: { app: { setActiveThread: async () => {} } } };
}

const { optimisticMatchesServerText, isTrailingQueuedUser, reduceThread } = await import(
  `${pathToFileURL(resolve("src/renderer/src/store.ts")).href}?test=${Date.now()}`
);

const skillXml = '<skill name="fxy-sync-dz" location="/skills/fxy-sync-dz">\nbody\n</skill>';

assert.equal(optimisticMatchesServerText("/skill:fxy-sync-dz", skillXml), true);
assert.equal(optimisticMatchesServerText("/fxy-sync-dz", skillXml), true);
assert.equal(optimisticMatchesServerText("/skill:fxy-sync-dz extra", skillXml + "\n\nextra"), true);
assert.equal(optimisticMatchesServerText("/skill:other", skillXml), false);
assert.equal(optimisticMatchesServerText("hello", "hello"), true);
assert.equal(optimisticMatchesServerText("hello", "world"), false);

assert.equal(isTrailingQueuedUser({ key: "opt-1", role: "user", text: "/skill:foo" }), false);
assert.equal(isTrailingQueuedUser({ key: "opt-1", role: "user", text: "steer", sendKind: "steer" }), true);
assert.equal(isTrailingQueuedUser({ key: "u-1", role: "user", text: "/skill:foo" }), false);

function thread(messages, extra = {}) {
  return { cwd: "/tmp", messages, streaming: extra.streaming ?? null, toolRuns: extra.toolRuns ?? {}, isStreaming: !!extra.streaming, ...extra };
}

const assistantStart = { type: "message_start", message: { role: "assistant" } };
const skillUserStart = { type: "message_start", message: { role: "user", content: skillXml } };

// Delayed skill expansion: assistant already streaming, user event must stay in front.
let t = thread([{ key: "opt-1", role: "user", text: "/skill:fxy-sync-dz" }]);
t = reduceThread(t, assistantStart);
t = reduceThread(t, skillUserStart);
assert.equal(t.messages[0].role, "user");
assert.equal(t.messages[0].text, skillXml);
assert.equal(t.messages[0].key.startsWith("opt-"), false);
assert.equal(t.messages.length, 1);
assert.equal(t.streaming?.role, "assistant");
t = reduceThread(t, { type: "agent_settled" });
assert.deepEqual(
  t.messages.map((m) => m.role),
  ["user", "assistant"],
  "settled skill turn must be user then assistant",
);

// Never-promoted first prompt still settles in front of the reply.
t = thread([{ key: "opt-1", role: "user", text: "/skill:foo" }], {
  streaming: { key: "a-1", role: "assistant", blocks: [] },
});
t = reduceThread(t, { type: "agent_settled" });
assert.deepEqual(
  t.messages.map((m) => m.role),
  ["user", "assistant"],
  "unpromoted first prompt must stay in front on settle",
);

// Steer still lands after the interrupted assistant.
t = thread(
  [
    { key: "u-1", role: "user", text: "hi" },
    { key: "opt-steer", role: "user", text: "stop", sendKind: "steer" },
  ],
  { streaming: { key: "a-1", role: "assistant", blocks: [] } },
);
t = reduceThread(t, { type: "message_start", message: { role: "user", content: "stop" } });
assert.deepEqual(
  t.messages.map((m) => m.role),
  ["user", "assistant", "user"],
  "steer must stay after the interrupted assistant",
);
assert.equal(t.messages[2].text, "stop");
assert.equal(t.streaming, null);

console.log("skill prompt tests passed");
