# jev-pi-orchestrator

The pi port of [jev-claude-orchestrator](https://github.com/damian87x/jev-claude-orchestrator):
a **madmax conductor** for [pi](https://pi.dev). Your main pi session splits a goal into many tiny
slices, [pi-subagents](https://www.npmjs.com/package/pi-subagents) workers implement them in parallel
worktrees, and [TypeSafe Jev](https://docs.typesafe.ai) makes every small decision: which worker tier
takes a slice, whether a worker is stuck, whether it's really done, and whether the diff should ship.

```text
Large model plans.   Jev decides.   Subagents execute.   Verification checks.

main pi session ── jevo tool ── slice new · triage ───────────────►  Jev: tier · risk · needs_human
      │  subagent({isolation:"worktree", workflowScript: runs.all([...])})
      ▼
jevo-worker-fast · jevo-worker · jevo-worker-reasoning         (background children, own worktrees)
      │  every N tool calls ── tool_execution_end ──── jevo health ─►  Jev: stuck? off track? → steer
      │  ends a turn without tool calls ── turn_end ── jevo gate
      │        gate command (code) → vetoes (code) → Jev QA → Jev staged review
      │        not done → reason queued as a follow-up → the worker keeps going (max 2 rounds)
      ▼        done → approved · escalate/error → jevo-reviewer or human
merge approved branches → integration tests → scoreboard
```

The policy (thresholds, vetoes, block rounds, statuses, ledger) lives in the Python core under `core/`,
**shared with the Claude Code plugin**, so both hosts make the same decisions. `core/UPSTREAM` records
which upstream commit it was vendored from.

## Install

```bash
pi install git:github.com/damian87x/jev-pi-orchestrator      # user-wide
pi install -l git:github.com/damian87x/jev-pi-orchestrator   # this project only
```

Requires `pi-subagents` (`pi install npm:pi-subagents`), `python3` (stdlib only) and `git`.
Jev key ([console](https://console.typesafe.ai/settings/keys)), first match wins: `TYPESAFE_API_KEY` env,
then `TYPESAFE_API_KEY=` in the nearest `.env` (keep it gitignored), then `~/.pi/agent/secrets/typesafe_api_key`.

Tuning (env): `JEVO_HEALTH_EVERY` (default 8, 0 = off), `JEVO_MAX_BLOCKS` (default 2), `JEVO_PYTHON`, `JEVO_DEBUG`.
Worker models are defaults. Override them in pi-subagents settings with `subagents.agentOverrides.<name>.model`:

| agent | default model | use |
|---|---|---|
| `jevo-worker-fast` | `openai-codex/gpt-5.6-luna` | triage tier `fast` |
| `jevo-worker` | `xai/grok-4.6` | tier `balanced` |
| `jevo-worker-reasoning` | `openai-codex/gpt-6-sol` | tier `reasoning` |
| `jevo-reviewer` | `claude-bridge/claude-opus-5` | read-only review of escalations |

## Use

Ask pi for `/skill:conductor-max <goal>`. The main session gets a `jevo` tool:

```text
jevo(["slice","new","--id","S1","--acceptance","calc.py defines add(a, b)","--allow","calc.py,tests/test_add.py","--gate","python3 -m unittest -q tests.test_add"])
jevo(["triage","--slice","S1"])
jevo(["slice","list"])
jevo(["report","--html",".jev-orchestrator/scoreboard.html"])
```

Each worker task must start with `JEV-SLICE: <id>`. `/jevo` in the TUI shows the slice list.
Workers must run as **background** children (the agent files set `async: true`), because pi-subagents
foreground children don't load installed extensions, and so wouldn't be supervised.

## Measured (2026-09-23, pi 0.85.1, pi-subagents 0.68.0, jev-1.13.0)

Headless `pi -p` in a clean pi profile that has only pi-subagents and this package installed. Two
`jevo-worker-fast` workers (gpt-5.6-luna) ran in parallel worktrees. S2 was told to "be quick, skip the tests".

| time | slice | what happened | Jev |
|---|---|---|---|
| +0 s | S2 | health check → continue | $0.00003 |
| +12 s | S1 | gate: test-first, committed → **approved** | $0.00008 |
| +15 s | S2 | tried to finish with a broken test → **sent back** ("failing evidence") | $0.00002 |
| +35 s | S2 | fixed the test, committed → **approved** | $0.00008 |

Total Jev spend: **$0.0002** (`jevo report`).

What the earlier live runs found and this version fixes:
- `gpt-5.4-mini` isn't available on a ChatGPT-login Codex account → the fast tier uses `gpt-5.6-luna`.
- pi-subagents hands the child `Task: <task>`, so the slice marker may follow that prefix, but it must
  still open the task. A conductor prompt that merely *quotes* a worker task is never supervised.
- A blocked worker called `contact_supervisor` and waited ~10 min for an answer that never came in
  headless mode. Workers now exclude that tool; the gate message tells them to report and finish.
- Workers given contradictory instructions ("only edit calc.py" plus a slice that needs a test file)
  are blocked twice and then escalated. That's the intended outcome.

Debug: `JEVO_DEBUG=/path/to/log` appends one line per supervision event (loaded, agent/slice detection, gate).

## Safety

- Code vetoes run before Jev and it can't override them: nonzero gate exit, parsed failure counts,
  missing slice files, files outside the allowlist, secret patterns, oversized diffs.
- Any error → `escalate`, never `approve`. Health failures are silent no-ops.
- Jev approval never pushes, merges to main or deploys. That stays with you and the human's authority.
- Diffs, gate-output tails and action summaries are sent to TypeSafe's API. The key is never logged.

## Develop

```bash
npm test     # node --test (extension logic) + python unittest (shared core)
```

## Credits

Same lineage as the Claude plugin: [thruwire/foreman](https://github.com/thruwire/foreman),
[jev-review](https://github.com/devagrawal09/jev-review), [reticle](https://github.com/reticlehq/reticle),
[kev](https://github.com/jaredpalmer/kev). MIT licensed.
