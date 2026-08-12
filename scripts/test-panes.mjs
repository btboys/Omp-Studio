import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { panesForActivate, panesForClose } = await import(
  `${pathToFileURL(resolve("src/renderer/src/lib/panes.ts")).href}?test=${Date.now()}`
);

// ---- activate ----
// single mode: hidden tab replaces the left pane
assert.deepEqual(panesForActivate({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: null }, "B"), {
  activeThreadId: "B",
  primaryThreadId: "B",
  paneThreadId: null,
});
// split, left focused: hidden tab replaces the left pane
assert.deepEqual(panesForActivate({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: "B" }, "C"), {
  activeThreadId: "C",
  primaryThreadId: "C",
  paneThreadId: "B",
});
// split, right focused: hidden tab replaces the right pane
assert.deepEqual(panesForActivate({ activeThreadId: "B", primaryThreadId: "A", paneThreadId: "B" }, "C"), {
  activeThreadId: "C",
  primaryThreadId: "A",
  paneThreadId: "C",
});
// focus the right pane (panes unchanged)
assert.deepEqual(panesForActivate({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: "B" }, "B"), {
  activeThreadId: "B",
  primaryThreadId: "A",
  paneThreadId: "B",
});
// focus the left pane (panes unchanged)
assert.deepEqual(panesForActivate({ activeThreadId: "B", primaryThreadId: "A", paneThreadId: "B" }, "A"), {
  activeThreadId: "A",
  primaryThreadId: "A",
  paneThreadId: "B",
});
// already focused: unchanged
assert.deepEqual(panesForActivate({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: null }, "A"), {
  activeThreadId: "A",
  primaryThreadId: "A",
  paneThreadId: null,
});

// ---- close ----
// close the right pane's thread -> collapse split, focus left
assert.deepEqual(panesForClose({ activeThreadId: "B", primaryThreadId: "A", paneThreadId: "B" }, "B", null), {
  activeThreadId: "A",
  primaryThreadId: "A",
  paneThreadId: null,
});
// close the left pane's thread while split -> right pane becomes the single view
assert.deepEqual(panesForClose({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: "B" }, "A", null), {
  activeThreadId: "B",
  primaryThreadId: "B",
  paneThreadId: null,
});
// close the left pane's thread while the right pane is focused -> same collapse
assert.deepEqual(panesForClose({ activeThreadId: "B", primaryThreadId: "A", paneThreadId: "B" }, "A", null), {
  activeThreadId: "B",
  primaryThreadId: "B",
  paneThreadId: null,
});
// close a hidden tab in split -> panes untouched
assert.deepEqual(panesForClose({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: "B" }, "C", "B"), {
  activeThreadId: "A",
  primaryThreadId: "A",
  paneThreadId: "B",
});
// single mode, close active -> fallback tab
assert.deepEqual(panesForClose({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: null }, "A", "B"), {
  activeThreadId: "B",
  primaryThreadId: "B",
  paneThreadId: null,
});
// single mode, close the last tab -> nothing left
assert.deepEqual(panesForClose({ activeThreadId: "A", primaryThreadId: "A", paneThreadId: null }, "A", null), {
  activeThreadId: null,
  primaryThreadId: null,
  paneThreadId: null,
});

// ---- invariant fuzz: the focused thread must always be displayed in a pane ----
const states = [
  { activeThreadId: "A", primaryThreadId: "A", paneThreadId: null },
  { activeThreadId: "B", primaryThreadId: "A", paneThreadId: "B" },
  { activeThreadId: "A", primaryThreadId: "A", paneThreadId: "B" },
  { activeThreadId: null, primaryThreadId: null, paneThreadId: null },
];
for (const s of states) {
  for (const id of ["A", "B", "C", "D"]) {
    const after = panesForActivate(s, id);
    assert.ok(after.activeThreadId === after.primaryThreadId || after.activeThreadId === after.paneThreadId, "activate: focused thread displayed");
    assert.ok(after.primaryThreadId !== after.paneThreadId, "activate: panes never duplicate");
  }
  for (const id of ["A", "B", "C", "D"]) {
    const after = panesForClose(s, id, "Z");
    assert.ok(after.activeThreadId === null || after.activeThreadId === after.primaryThreadId || after.activeThreadId === after.paneThreadId, "close: focused thread displayed");
    assert.ok(after.primaryThreadId === null || after.primaryThreadId !== after.paneThreadId, "close: panes never duplicate");
  }
}

console.log("panes tests passed");
