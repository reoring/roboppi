# Kubernetes Operator Dev Loop

This example is a generic long-running agents workflow for developing a
Kubernetes operator or controller-based platform component.

It is derived from a real multi-agent development loop, but the repo-specific
names and assumptions were removed so it can serve as a reusable example.

## What It Demonstrates

- A lead-driven implement -> review -> verify loop
- Planner-owned living TODO, memory, issue index, and rerun contract state
- Dormant specialist activation for:
  - manual verification
  - long-running E2E
  - Kubernetes debugging
  - spec clarification
  - provenance / rerun gatekeeping
  - loop and stall recovery
- Completion checks that look at TODO state, blockers, and verification results

## Intended Workspace

Run it against a repository that already has some combination of:

- `request.md`
- `implementation-plan.md` or an equivalent repo-local design/plan document
- `ARCHITECTURE.md` or `docs/**`
- controller / API / chart / test code

Typical fit:

- an operator repo with CRDs and controllers
- a platform repo with Kubernetes reconciliation logic
- a repo where local fast gates and separate cluster-backed validation both exist

## Run

```bash
cd /home/reoring/project/roboppi
bun run src/workflow/run.ts \
  examples/kubernetes-operator-dev-loop/workflow.yaml \
  --workspace /path/to/your/operator-repo \
  --verbose
```

Or with the built binary:

```bash
cd /home/reoring/project/roboppi
./roboppi workflow \
  examples/kubernetes-operator-dev-loop/workflow.yaml \
  --workspace /path/to/your/operator-repo \
  --verbose
```

## Notes

- The workflow loads the colocated `agents.yaml` automatically.
- `context_dir` is relative to the target workspace, so state is written under
  `.roboppi-loop/operator-dev/` in that repo.
- You will usually want to adapt:
  - the fast-gate commands in `workflow.yaml`
  - the repo-local plan filename
  - the dormant specialist policies in `agents.yaml`
  - the completion-check criteria
