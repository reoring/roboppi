# Supervised IPC: submit_job ACK timeout (non-interactive)

Status: resolved (socket transport for supervised IPC); stdio root-cause remains environment-dependent

## Problem

When running workflows in `--supervised` mode (Supervisor -> Core IPC -> Worker), some non-interactive executions fail in the very first step (`bootstrap`) with an IPC timeout waiting for `submit_job` acknowledgement.

Observed failure:

```
Core IPC submit_job timed out after <N>ms (jobId=... requestId=...)
```

Key symptom from IPC tracing:

- Runner logs `tx submit_job`.
- Core is spawned and prints startup logs to stderr.
- Core never logs `rx submit_job` and never sends `ack`.

So the break is: Runner -> Core stdin (message never observed by Core).

Mitigation: use the socket-based supervised IPC transport (`AGENTCORE_SUPERVISED_IPC_TRANSPORT=socket`) which bypasses stdio pipes entirely.

## Repro

Typical demo repro (force stdio; may fail in affected environments):

```bash
AGENTCORE_SUPERVISED_IPC_TRANSPORT=stdio \
  AGENTCORE_IPC_TRACE=1 AGENTCORE_IPC_REQUEST_TIMEOUT=45s VERBOSE=0 \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

Socket transport (expected to succeed):

```bash
AGENTCORE_SUPERVISED_IPC_TRANSPORT=socket \
  AGENTCORE_IPC_TRACE=1 AGENTCORE_IPC_REQUEST_TIMEOUT=2m VERBOSE=0 \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

Note: `src/workflow/run.ts` defaults `AGENTCORE_SUPERVISED_IPC_TRANSPORT=socket` in non-interactive `--supervised` runs.

Notes:

- This issue is about IPC request/response, not the workflow YAML `timeout`.
- Keepalive output can avoid "no output" watchdogs, but it does not fix IPC request timeouts.

## Investigation Summary

1) Keepalive vs timeouts

- Added keepalive output to `src/workflow/run.ts` to avoid environments killing silent processes.
- Confirmed keepalive works in non-supervised runs.
- In supervised runs, failures were confirmed to be IPC request timeouts (not watchdog SIGTERM).

2) IPC request timeout

- Found default IPC request timeout of 30s (`DEFAULT_REQUEST_TIMEOUT_MS = 30_000`).
- Made IPC request timeout configurable and raised default for supervised runner to `2m`:
  - CLI: `--ipc-request-timeout <DurationString>`
  - env: `AGENTCORE_IPC_REQUEST_TIMEOUT` / `AGENTCORE_IPC_REQUEST_TIMEOUT_MS`

3) Step timeout interaction

- Observed step-level timeouts (e.g. `bootstrap: timeout: 2m`) could abort before longer IPC timeouts.
- Adjusted supervised runner so step timeouts apply to *worker execution budget* (post-ACK), not Core startup/ACK waiting.

4) Pinpointing the stuck IPC op

- Enriched errors to include which op timed out: `submit_job` vs `request_permit` vs `cancel_job`.
- In the failing path, it is consistently `submit_job` ACK.

5) IPC trace tooling

- Added `AGENTCORE_IPC_TRACE=1` support in `src/ipc/json-lines-transport.ts`:
  - Logs `tx`/`rx` with pid/type/requestId/jobId.
- Added demo trace helpers:
  - `examples/agent-pr-loop-demo/run-in-tmp.sh` prints `AGENTCORE_ROOT` and git SHA when tracing.

6) Transport-level errors

- Added transport close/error handling in `src/ipc/protocol.ts` so pending requests fail fast on disconnect.
- In the failing cases, there are *no* transport parse/disconnect errors.

7) Core spawn / stdio bridging

- Moved Core spawning to `node:child_process.spawn` in `src/scheduler/supervisor.ts`.
- Piped Core stderr to parent stderr for visibility.
- Ensured child env is explicitly passed (Bun.spawn does not inherit runtime-updated `process.env`).
- Changed stdin writes to Core to always use callback-based `write()` and await completion.
- Adjusted Core IPC stdin source:
  - Prefer `Bun.stdin.stream()` for IPC input in `src/index.ts` (fallback to `process.stdin` when needed).

These changes improve supervised IPC in many environments, but some setups still drop stdio messages entirely (Runner `tx` without Core `rx`).

8) Socket-based supervised IPC transport

- Added a Unix socket transport for supervised IPC to bypass stdio pipes: `AGENTCORE_SUPERVISED_IPC_TRANSPORT=socket`.
- `src/workflow/run.ts` defaults to `socket` in non-interactive `--supervised` runs (override via `AGENTCORE_SUPERVISED_IPC_TRANSPORT=stdio|socket`).
- Core connects via `AGENTCORE_IPC_SOCKET_PATH` (set by Supervisor).

## Related Work (Agent PR Loop Demo)

While investigating, the agent PR loop demo/workflow was also strengthened:

- `examples/agent-pr-loop.yaml`: changed to loop `implement` (Claude Code) based on review verdict, using `completion_check`.
- `completion_check` decision now supports file-based decision via `decision_file` to avoid reliance on stdout markers.
- `scripts/agent-pr-loop/review-inputs.sh`: generates `.agentcore-loop/review.untracked.diff` so reviews include untracked file diffs.
- `examples/agent-pr-loop-demo/request.md`: raised quality bar with explicit edge cases.
- `examples/agent-pr-loop-demo/run-in-tmp.sh`: added black-box verification after workflow completion.

## Current Status / Next Steps

- Root issue: supervised stdio pipes can drop Runner -> Core messages in some non-interactive environments, leading to `submit_job` ACK timeouts.
- Mitigation implemented: socket transport for supervised IPC (`AGENTCORE_SUPERVISED_IPC_TRANSPORT=socket`), now the default in non-interactive `--supervised` runs via `src/workflow/run.ts`.
- If you need the old behavior (or want to repro the original failure), force: `AGENTCORE_SUPERVISED_IPC_TRANSPORT=stdio`.

## 2026-02-14 Follow-up

Implemented additional stdio hardening to reduce the chance of Supervisor → Core stdin messages being silently dropped in non-interactive supervised startup.

### Changes made

- `src/index.ts`: added a compatibility fallback for Core stdin selection.
  - Use `Bun.stdin.stream()` when available.
  - Fallback to `Readable.toWeb(process.stdin)` when unavailable.
- `src/scheduler/supervisor.ts`: harden Core `stdin` transport setup.
  - Best-effort `proc.stdin.setDefaultEncoding("utf8")`.
  - Best-effort `proc.stdin.setNoDelay(true)`.
  - Added Core stdin error logging (`[IPC][core-stdin-error]`).

### Remaining validation steps (stdio transport)

- Re-run the repro with `AGENTCORE_IPC_TRACE=1`.
- Confirm trace includes:
  - `tx submit_job` (Runner)
  - `rx submit_job` (Core)
  - `tx ack` (Core)
  - `rx ack` (Runner)
- If missing still occurs, next check is child-process group/session wrapping in the outer execution environment and disable those wrappers before spawning Core.

### 2026-02-14 (stdio) 再実行結果

- Repro command (forced stdio):
  - `AGENTCORE_SUPERVISED_IPC_TRANSPORT=stdio AGENTCORE_IPC_TRACE=1 AGENTCORE_IPC_REQUEST_TIMEOUT=45s VERBOSE=0 bash examples/agent-pr-loop-demo/run-in-tmp.sh`
  - `AGENTCORE_SUPERVISED_IPC_TRANSPORT=stdio AGENTCORE_IPC_TRACE=1 AGENTCORE_IPC_REQUEST_TIMEOUT=20s bun run src/workflow/run.ts examples/hello-world.yaml --supervised`
- Both commands still show:
  - Runner `tx submit_job`
  - Core startup logs (`AgentCore starting`, `AgentCore started, awaiting IPC messages`)
  - **No Core `[IPC][rx]` / ack**
  - 20–45s timeout then workflow fail
- Additional isolation check:
  - `AGENTCORE_IPC_TRACE=1 bun /home/reoring/roboppi/src/index.ts` with shell pipe (`printf ... | bun src/index.ts`) works and prints Core `[IPC][rx] submit_job` + `ack`.
  - The supervisor-like path that uses Bun runtime + `node:child_process` writing to a child bun process does not elicit Core `[IPC][rx]`, even when using minimal writer scripts.
- Current hypothesis update (stdio):
  - On this machine, Bun runtime process-spawn + pipe transport may discard `stdin` for child bun processes at transport layer.
  - Stdio may remain unreliable in some environments; avoid spending more time on timeouts/retries until transport is robust.

### 2026-02-14 (socket) 再実行結果

- Verified socket transport fixes the issue end-to-end:
  - `AGENTCORE_SUPERVISED_IPC_TRANSPORT=socket AGENTCORE_IPC_REQUEST_TIMEOUT=2m VERBOSE=0 bash examples/agent-pr-loop-demo/run-in-tmp.sh` -> workflow `SUCCEEDED` and demo post-checks passed.
  - `AGENTCORE_IPC_TRACE=1 bun run src/workflow/run.ts examples/hello-world.yaml --supervised` -> Core `[IPC][rx] submit_job` and `ack` observed; workflow `SUCCEEDED`.
- Full test suite passes: `bun test` (949 tests).
- Conclusion: use socket transport for non-interactive supervised runs; keep stdio as a fallback/debug option.
