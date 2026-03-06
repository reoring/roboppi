# agents-dynamic-team demo

Demonstrates **dynamic agent team creation** — the lead agent starts alone, reads a project spec, then adds specialist agents at runtime using the agents CLI.

## What makes this different

In the `agents-review-loop-demo`, all team members are pre-configured in `workflow.yaml`. Here, only the **lead** is pre-configured. The lead:

1. Reads the project specification
2. Decides what specialists are needed
3. Uses `roboppi agents members upsert` to add them dynamically
4. The coordinator's reconcile loop detects new members and spawns them
5. The lead creates tasks and assigns them to the new members

This pattern is useful when the team composition depends on the project requirements and can't be determined upfront.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │           Workflow YAML              │
                    │  agents.members: { lead: lead_agent }│
                    │  (only the lead is pre-configured)  │
                    └───────────────┬─────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────┐
                    │          AgentCoordinator             │
                    │  - spawns lead at startup             │
                    │  - reconcile loop every ~10s:         │
                    │    reads members.json → spawns new    │
                    │    members, shuts down removed ones   │
                    └───────────────┬──────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
    ┌─────▼─────┐           ┌──────▼──────┐          ┌───────▼──────┐
    │   lead    │  upsert   │  math-dev   │          │  string-dev  │
    │ (start)   │──────────►│ (spawned)   │          │  (spawned)   │
    │           │  upsert   │             │          │              │
    │           │──────────►│             │          │              │
    └─────┬─────┘           └──────┬──────┘          └───────┬──────┘
          │                        │                         │
          │  upsert         ┌──────▼──────┐                  │
          │────────────────►│   tester    │◄─────────────────┘
          │                 │  (spawned)  │   (tests both modules)
          │                 └─────────────┘
          │
    ┌─────▼──────────────────────────────────────────────────┐
    │                    Mailbox + Tasks                      │
    │  - Lead creates tasks, assigns to members              │
    │  - Members claim tasks, implement, send updates        │
    │  - Lead monitors and coordinates the loop              │
    └────────────────────────────────────────────────────────┘
```

## The dynamic membership flow

```
1. Workflow starts → only "lead" in members.json

2. Lead reads spec → decides: need math-dev, string-dev, tester

3. Lead runs:
     roboppi agents members upsert --member math-dev --agent implementer
     roboppi agents members upsert --member string-dev --agent implementer
     roboppi agents members upsert --member tester --agent tester

4. Coordinator reconcile loop (every ~10s):
     - Reads members.json → sees 3 new members
     - Spawns ResidentAgent for each
     - New agents start polling their inbox/tasks

5. Lead creates tasks:
     roboppi agents tasks add --title "Implement math module" --assigned-to math-dev
     roboppi agents tasks add --title "Implement string module" --assigned-to string-dev

6. math-dev and string-dev claim and complete their tasks

7. Lead creates test tasks:
     roboppi agents tasks add --title "Test math module" --assigned-to tester
     roboppi agents tasks add --title "Test string module" --assigned-to tester

8. Tester writes and runs tests

9. Completion check verifies: all files exist, bun test passes
```

## Prerequisites

- `bun`
- `git`
- `claude` (Claude Code CLI)

## Run

From the Roboppi repo root:

```bash
bash examples/agents-dynamic-team/run-in-tmp.sh
```

### Use a fixed workspace path

```bash
TARGET=/tmp/roboppi-dynamic-team \
  bash examples/agents-dynamic-team/run-in-tmp.sh
```

### With TUI

```bash
TUI=1 bash examples/agents-dynamic-team/run-in-tmp.sh
```

## What it generates

In the generated workspace:

- `package.json` — Project config
- `src/math.ts` — Math utility functions
- `src/string-utils.ts` — String utility functions
- `test/math.test.ts` — Math module tests
- `test/string-utils.test.ts` — String module tests

## Key concepts demonstrated

- **Dynamic membership**: The lead adds members at runtime via `roboppi agents members upsert`. No teammates are pre-configured in the workflow YAML.
- **Coordinator reconcile loop**: Automatically detects new/removed members in `members.json` and spawns/shuts down ResidentAgents.
- **Agent catalog separation**: Agent profiles are defined in `agents.yaml` but not bound to team members until the lead decides at runtime.
- **Task-driven coordination**: The lead creates tasks, assigns them to dynamically-added members, and monitors completion.
- **Mailbox messaging**: Agents communicate progress and feedback via the file-backed mailbox.
- **Phased execution**: The lead orchestrates phases (implement → test) by creating tasks in sequence.

## Verify

After the demo completes:

```bash
cd <printed-workspace-path>
bun test
```
