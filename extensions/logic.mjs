// Pure helpers for the pi extension. No pi imports, so node --test can exercise them directly.

export const BINDING_KEY = "jev-pi-orchestrator/1";
// Must open the task (pi-subagents prefixes it with "Task: "), not merely appear somewhere in a prompt.
const MARKER = /^\s*(?:Task:\s*)?JEV-SLICE:\s*([A-Za-z0-9_.-]+)/;

/** Agent name from the `<active_agent name="..."/>` tag pi-subagents puts at the top of a child's system prompt. */
export function activeAgent(systemPrompt) {
  const m = /<active_agent\s+name="([^"]+)"/.exec(systemPrompt || "");
  return m ? m[1] : null;
}

export function isWorker(agentName) {
  return typeof agentName === "string" && /(^|[.:/])jevo-worker(-|$)/.test(agentName);
}

export function sliceFromText(text) {
  const m = MARKER.exec(text || "");
  return m ? m[1] : null;
}

/** Slice id passed by the conductor through the subagent tool's extensionBindings, if any. */
export function sliceFromBindings(raw) {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw)[BINDING_KEY];
    return b && typeof b.slice === "string" && /^[A-Za-z0-9_.-]+$/.test(b.slice) ? b.slice : null;
  } catch {
    return null;
  }
}

/** The worker is trying to finish: an assistant turn that ended normally with no tool calls. */
export function isFinalAnswer(message) {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason && message.stopReason !== "stop") return false;
  return !(message.content || []).some((c) => c && c.type === "toolCall");
}

export function summarizeAction(toolName, args, result, isError) {
  const a = args || {};
  const target = a.command ?? a.path ?? a.file_path ?? a.pattern ?? "";
  let text = "";
  if (result && Array.isArray(result.content)) {
    text = result.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  } else if (typeof result === "string") {
    text = result;
  }
  return { tool: toolName, target: String(target).slice(0, 160), result: (isError ? "ERROR " : "") + text.slice(0, 200) };
}

/** Last JSON object printed by jevo.py (it prints exactly one, pretty-printed). */
export function parseJevo(stdout) {
  const start = (stdout || "").indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

/** A bounded ring of recent actions plus a counter; health runs every `every` calls. */
export function makeTracker(every, keep = 12) {
  const recent = [];
  let n = 0;
  return {
    record(action) {
      n += 1;
      recent.push(action);
      if (recent.length > keep) recent.shift();
      return every > 0 && n % every === 0;
    },
    recent: () => recent.slice(),
    count: () => n,
  };
}
