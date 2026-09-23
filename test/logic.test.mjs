import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeAgent,
  isFinalAnswer,
  isWorker,
  makeTracker,
  parseJevo,
  sliceFromBindings,
  sliceFromText,
  summarizeAction,
} from "../extensions/logic.mjs";

test("reads the pi-subagents active agent tag", () => {
  assert.equal(activeAgent('<active_agent name="jevo-worker-fast"/>\nYou implement...'), "jevo-worker-fast");
  assert.equal(activeAgent("no tag here"), null);
});

test("only jevo workers are supervised, not the reviewer or other agents", () => {
  for (const n of ["jevo-worker", "jevo-worker-fast", "jevo-worker-reasoning", "pkg.jevo-worker"]) assert.ok(isWorker(n), n);
  for (const n of ["jevo-reviewer", "worker", "scout", null, "my-jevo-workerish"]) assert.ok(!isWorker(n), String(n));
});

test("slice id comes from the task marker or the extension bindings", () => {
  assert.equal(sliceFromText("JEV-SLICE: S12-fix1\nGoal: x"), "S12-fix1");
  assert.equal(sliceFromText("no marker"), null);
  // live run: pi-subagents hands the child "Task: <task>"
  assert.equal(sliceFromText("Task: JEV-SLICE: S1\nGoal: x"), "S1");
  // live run: the conductor's own prompt quoted a worker task; it must not become a supervised slice
  assert.equal(sliceFromText('Call the subagent tool... task: "JEV-SLICE: S2\\nAdd sub"'), null);
  assert.equal(sliceFromBindings(JSON.stringify({ "jev-pi-orchestrator/1": { slice: "S3" } })), "S3");
  assert.equal(sliceFromBindings(JSON.stringify({ "jev-pi-orchestrator/1": { slice: "../etc" } })), null);
  assert.equal(sliceFromBindings("not json"), null);
});

test("gate fires only when the worker tries to finish", () => {
  const text = { type: "text", text: "Done." };
  const call = { type: "toolCall", id: "1", name: "bash", arguments: {} };
  assert.ok(isFinalAnswer({ role: "assistant", stopReason: "stop", content: [text] }));
  assert.ok(!isFinalAnswer({ role: "assistant", stopReason: "toolUse", content: [text, call] }));
  assert.ok(!isFinalAnswer({ role: "assistant", stopReason: "aborted", content: [text] }));
  assert.ok(!isFinalAnswer({ role: "assistant", stopReason: "error", content: [] }));
  assert.ok(!isFinalAnswer({ role: "user", content: [text] }));
});

test("health runs every N recorded actions and keeps a bounded window", () => {
  const t = makeTracker(3, 4);
  const fired = [1, 2, 3, 4, 5, 6].map((i) => t.record({ tool: "bash", target: String(i) }));
  assert.deepEqual(fired, [false, false, true, false, false, true]);
  assert.equal(t.recent().length, 4);
  assert.equal(t.recent()[0].target, "3");
  assert.ok(!makeTracker(0).record({}));
});

test("action summaries are bounded and flag errors", () => {
  const s = summarizeAction("bash", { command: "x".repeat(500) }, { content: [{ type: "text", text: "y".repeat(500) }] }, true);
  assert.equal(s.target.length, 160);
  assert.ok(s.result.startsWith("ERROR "));
  assert.ok(s.result.length <= 206);
});

test("parses jevo's pretty-printed JSON and rejects junk", () => {
  assert.deepEqual(parseJevo('{\n  "block": true,\n  "message": "fix it"\n}\n'), { block: true, message: "fix it" });
  assert.equal(parseJevo("Traceback: boom"), null);
  assert.equal(parseJevo(""), null);
});
