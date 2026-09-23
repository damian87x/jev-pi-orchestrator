/**
 * jev-pi-orchestrator — Jev-supervised madmax conductor for pi.
 *
 * Main session: a `jevo` tool and `/jevo` command over the shared Python core (core/scripts/jevo.py).
 * Inside a `jevo-worker*` subagent (background children load installed extensions):
 *   - finish gate: when the worker ends a turn with no tool calls, run `jevo gate`; if the slice is not
 *     done, queue the reason as a follow-up so the same run keeps going (max_blocks rounds, then escalate).
 *   - health: every N tool calls, `jevo health` judges stuck / off-track and steers the worker.
 * All policy (thresholds, vetoes, rounds, statuses, ledger) lives in the Python core, shared with the
 * Claude Code plugin. This file only wires pi events to it.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  activeAgent,
  isFinalAnswer,
  isWorker,
  makeTracker,
  parseJevo,
  sliceFromBindings,
  sliceFromText,
  summarizeAction,
} from "./logic.mjs";

const HERE = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const JEVO = join(HERE, "..", "core", "scripts", "jevo.py");
const PY = process.env.JEVO_PYTHON || "python3";
const HEALTH_EVERY = Number(process.env.JEVO_HEALTH_EVERY ?? 8);
const MAX_BLOCKS = String(Number(process.env.JEVO_MAX_BLOCKS ?? 2));
const GATE_TIMEOUT_MS = 900_000;
const DEBUG = process.env.JEVO_DEBUG; // a file path: append one line per supervision event

function debug(...parts: unknown[]) {
  if (!DEBUG) return;
  try {
    appendFileSync(DEBUG, `${new Date().toISOString()} ${process.pid} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
  } catch {
    // debugging must never break anything
  }
}

export default function (pi: ExtensionAPI) {
  const bindingSlice = sliceFromBindings(process.env.PI_SUBAGENT_EXTENSION_BINDINGS);
  let agent: string | null = null;
  let slice: string | null = bindingSlice;
  const tracker = makeTracker(HEALTH_EVERY);

  const jevo = (args: string[], cwd: string, timeout = 120_000) =>
    pi.exec(PY, [JEVO, ...args], { cwd, timeout });

  const supervising = () => isWorker(agent) && !!slice;
  debug("loaded", { child: process.env.PI_SUBAGENT_CHILD ?? null, bindingSlice });

  pi.on("before_agent_start", (event) => {
    agent ??= activeAgent(event.systemPrompt);
    slice ??= sliceFromText(event.prompt);
    debug("before_agent_start", { agent, slice, supervising: supervising(), promptHead: String(event.prompt).slice(0, 60) });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!supervising()) return;
    if (!tracker.record(summarizeAction(event.toolName, event.args, event.result, event.isError))) return;
    try {
      const r = await jevo(["health", "--slice", slice!, "--actions", JSON.stringify(tracker.recent())], ctx.cwd, 30_000);
      const out = parseJevo(r.stdout);
      if (out?.steer) {
        pi.sendMessage({ customType: "jevo-health", content: out.steer, display: true }, { deliverAs: "steer" });
      }
    } catch {
      // supervision must never break the worker
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!supervising() || !isFinalAnswer(event.message)) return;
    const r = await jevo(
      ["gate", "--slice", slice!, "--cwd", ctx.cwd, "--max-blocks", MAX_BLOCKS, "--agent", agent!],
      ctx.cwd,
      GATE_TIMEOUT_MS,
    );
    const out = parseJevo(r.stdout);
    debug("gate", { slice, code: r.code, block: out?.block, status: out?.status, stderr: (r.stderr || "").slice(-300) });
    if (out?.block && out.message) {
      pi.sendMessage({ customType: "jevo-gate", content: out.message, display: true }, { deliverAs: "followUp" });
    }
    // not blocked: approved, escalated, final, or the gate itself failed. The slice file and ledger
    // record which; nothing here ever marks a slice approved.
  });

  pi.registerTool({
    name: "jevo",
    label: "Jev orchestrator",
    description:
      "Run the conductor-max decision CLI: `slice new|list`, `triage`, `check`, `gate`, `report`. " +
      "Returns jevo's JSON (decision, exit, reason...). Exit 0 proceed, 1 fix, 3 escalate, 2 error.",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: 'CLI arguments, e.g. ["slice","new","--id","S1","--acceptance","...","--allow","a.py,tests/test_a.py","--gate","pytest -q tests/test_a.py"]',
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = await jevo(params.args, ctx.cwd, GATE_TIMEOUT_MS);
      const text = (r.stdout || r.stderr || "").trim() || `jevo exited ${r.code}`;
      return { content: [{ type: "text", text }], details: { code: r.code } };
    },
  });

  pi.registerCommand("jevo", {
    description: "Jev orchestrator: /jevo [slice list | report | ...] (default: slice list)",
    handler: async (args, ctx) => {
      const argv = (args || "").trim() ? (args as string).trim().split(/\s+/) : ["slice", "list"];
      const r = await jevo(argv, ctx.cwd);
      ctx.ui.notify((r.stdout || r.stderr || `exit ${r.code}`).trim().slice(0, 4000), r.code === 0 ? "info" : "warning");
    },
  });
}
