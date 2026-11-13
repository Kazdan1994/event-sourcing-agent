# event-sourcing-agent

A small tool-calling agent whose only state is an append-only event journal. Kill it at any point, run `resume`, and it picks up where it stopped. Run `replay`, and the same loop runs again from the journal without calling the model.

The agent answers SaaS pricing questions ("How much is Notion Plus for 5 seats, billed monthly?") using three read-only tools over a catalog of hand-annotated pricing pages. It runs locally on [Ollama](https://ollama.com) with `qwen3:8b`.

Write-up: [Event Sourcing for AI agents: kill the process, resume, replay](https://dev.to/arthurjacquemin/event-sourcing-for-ai-agents-kill-the-process-resume-replay-4apg).

## How it works

- One JSONL file per run in `runs/`, one Zod-validated event per line: `run_started`, `turn_started`, `model_decision`, `tool_called`, `tool_result`, …, `run_ended`.
- Every event is written and fsynced before the agent acts on it.
- The state is `fold(events)`, a pure function. Start, resume, `list` and replay all go through it.
- Replay feeds the recorded decisions back into the real loop and stops at the first event that diverges from the journal.

The full design (resume cases, torn lines, locks, replay, limits) is in [NOTES.md](NOTES.md).

## Run it

Requires [Bun](https://bun.sh) and Ollama with `qwen3:8b` pulled.

```sh
bun install
ollama pull qwen3:8b

bun run agent run "How much is Notion Plus for 5 seats, billed monthly?"
bun run agent list
bun run agent resume <runId>
bun run agent show <runId>
bun run agent replay <runId> [--live-tools]
```

`bun run demo` starts a run, kills it with SIGKILL once the first tool result is on disk, then runs `list`, `resume`, `show` and `replay`.

Set `OLLAMA_URL` if Ollama isn't on `http://localhost:11434`.

## Tests

```sh
bun run test
bun run typecheck
```

The tests don't need Ollama. They crash a 3-tool run after every event boundary and check that each resume reaches the same ending without re-running a tool whose result was already recorded.

## Layout

```
src/              journal, schema, fold, agent loop, replay, CLI
src/agent-loop/   the original agent: model client, tools, catalog, budget constants
src/pricing/      Zod schema for pricing grids
annotations/      hand-annotated pricing grids the tools read from
```

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 1 | model failed |
| 2 | usage error |
| 3 | run already ended |
| 4 | run locked by a live process |
| 5 | invalid journal |
| 6 | replay diverged |
