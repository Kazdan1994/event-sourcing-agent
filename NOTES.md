# S15 — Agent state as a replayable event log

The S11 CompareTiers agent, rebuilt so that every step is an event in an append-only journal.
The journal is the only state. Kill the process at any point, run `resume`, and the agent picks
up where it stopped. Run `replay`, and the same loop runs again from the journal without the
model.

## Event model

One JSONL file per run in `runs/` (gitignored), one Zod-validated event per line:

`run_started` → per turn `turn_started` → `model_decision` (or `model_failed`) →
`tool_called` → `tool_result` / `tool_error` → … → `run_ended`, plus `run_resumed` on each
resume.

`turn_started` is written before the model is called. That is how a turn cut off mid-call
shows up in the log, and why it still counts against the budget: crashing does not buy extra
turns.

## Durability rule

An event is written and fsynced before the agent acts on it. `tool_called` lands before the
tool runs, and `tool_result` before the next model call. On resume there are only a few cases:

| last event | resume does |
|---|---|
| `tool_called` | runs the tool again (tools are read-only, so this is safe) |
| `model_decision` with a tool | writes `tool_called`, runs the tool |
| `turn_started`, `model_failed` | starts a new turn; the lost one is already counted |
| a result, or `run_started` | evaluates the stop rules, then starts a new turn or writes `run_ended` |
| `run_ended` | refuses (exit 3) |

The state is `fold(events)`, a pure function. Start, resume, `list` and replay all go through
it, so there is no second copy of the state that could drift.

A torn last line (a crash in the middle of a write) is dropped with a warning, and rewritten
away before the next append. An invalid line anywhere else is a hard error naming the seq.

## Locks

`<runId>.lock` holds the pid of the process driving the run. A live pid means refusal
(exit 4). A dead pid, which is what SIGKILL leaves behind, means the lock is stale: it is taken
over and the old pid is recorded in `run_resumed.staleLockPid`.

## Replay

Replay feeds the recorded decisions to the real loop through a fake `decide`, and by default
the recorded tool results too. It compares every event the loop produces with the journal
(kind and payload, ignoring time and token usage) and stops at the first mismatch. Model
calls: zero, by construction.

What it catches: anything the code derives, such as `tool_called` arguments that don't match
the decision, a stop rule that changed, or a final result that no longer leads to the recorded
`run_ended`. What it can't catch with recorded results: an edited `tool_result` whose data is
replayed as-is. `--live-tools` re-runs the tools against the catalog and catches that case.

## Reuse of S11

S11's `runAgent` keeps its state in local variables, with no seam between steps, so the loop
is rewritten here (`agent.ts`, `state.ts`). The pieces with behaviour are imported unchanged:
`executeCall` (validation, `unseenAmounts`), `isNoProgress`, `capResult`, `SYSTEM_PROMPT`, the
tools, `callOllama`, `loadCatalog` and the budget constants. S11 is not modified.

## Demo (2026-10-29, Ollama qwen3:8b)

`bun run src/demo.ts` starts a run, sends SIGKILL once the first `tool_result` is on disk, then
runs `list`, `resume`, `show`, `replay` and a second `resume`.

- Kill landed during turn 2, after `turn_started` and before the decision: 6 events on disk.
- `list`: `interrupted`, turns 2/8, with a stale lock left behind.
- `resume`: took over the stale lock, started turn 3, ended `success` ("Notion Plus for 5
  seats, billed monthly, costs 47.50 EUR."). First new event 51 ms after launch (SC-005 target
  < 2 s).
- Totals across the crash: turns 4/8 (the lost turn counted), 3 tool calls, 0 retries,
  1 resume, 1933 + 106 tokens, 16.4 s of model time.
- `replay`: match after 15 steps, 0 model calls. With `seats` edited from 5 to 9 in a
  `tool_called` line: divergence at seq 10, exit 6.
- Second `resume`: refused, exit 3.

Tests (`bun test src`) cover a crash after every one of the 13 event boundaries of a 3-tool
run. Each resume reaches the same ending, and no tool call with a recorded result runs again
(SC-001).

## Limits

- Exactly-once side effects are out of scope. A tool whose call was recorded without its result
  runs again on resume, which is only safe because every tool is read-only.
- One machine, one operator. The lock is a pid file, not a distributed lock.
- No compaction or retention: journals stay until deleted.
