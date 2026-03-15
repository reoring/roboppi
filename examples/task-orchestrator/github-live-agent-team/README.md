# GitHub Live Agent Team Example

This example shows how to run `task-orchestrator serve` against a real GitHub
repository with actual Roboppi agent teams.

Unlike `github-issue-demo/`, this example is not CI-safe:

- it requires a real repository and local clone
- it requires `gh auth login`
- it requires at least one authenticated worker CLI such as `claude` or `codex`

The included workflows model two resident teams:

- `issue-team`: `lead` + `implementer` + `reporter`
- `review-team`: `lead` + `reviewer` + `reporter`

The reporting path stays sink-agnostic inside the agents:

- implementer/reviewer send structured mailbox updates to the lead
- new human GitHub issue comments are bridged into the lead inbox as `operator_comment`
- lead forwards publishable milestones to the reporter
- reporter emits internal task activity with `roboppi task-orchestrator activity emit`
- lead records PR-open / review / merge intent with `roboppi task-orchestrator intent emit`
- the task orchestrator projects that activity to GitHub according to `reporting.sinks.github`
- the task orchestrator applies provider-side PR open/review/merge with `roboppi task-orchestrator github apply-pr-open` and `roboppi task-orchestrator github apply-pr-review`

## Files

- `task-orchestrator.template.yaml`
  - Fill in your repo name, local clone path, labels, and absolute workflow paths.
- `workflows/agents.yaml`
  - Actual worker profiles for the lead / implementer / reviewer / reporter teams.
- `workflows/issue-workflow.yaml`
  - Issue instance workflow that creates a branch, commit, push, and a PR-open request.
- `workflows/pr-review-workflow.yaml`
  - Pull-request review workflow that records review/merge intent and lets the runtime apply it.

## Preparation

1. Clone the target repository locally.
2. Create issue / PR labels for Roboppi routing.
3. Copy `task-orchestrator.template.yaml` to a real config file and replace the placeholders.
4. If needed, change the worker kinds in `workflows/agents.yaml` to match the CLIs you have authenticated locally.

## Run

```bash
roboppi task-orchestrator serve /abs/path/to/task-orchestrator.yaml
```

Then create a GitHub issue with the configured label. A typical test issue is:

```text
Append a short line to README.md describing this issue number, then open a PR.
```

The issue workflow should:

1. pick up the issue
2. bridge new operator comments into the lead inbox while the issue instance is active
3. create a branch
4. commit and push a change
5. record a PR-open request and let the runtime open the PR
6. move the issue task to `review_required`

If the issue is underspecified, the issue workflow may instead:

1. emit `clarification_request`
2. land in `waiting_for_input`
3. resume when a human issue comment is bridged back into the lead inbox as `operator_comment`
4. continue toward PR creation on the next issue-team run

In this example, the implementer reports ambiguity with a structured
`implementation_blocker` mailbox payload. The lead reuses that mailbox body
directly as the `clarification_request` intent payload instead of reconstructing
the JSON by hand.

The PR review workflow should:

1. pick up the labeled PR
2. review and approve it
3. merge it
4. move the PR task to `landed`

## Notes

- These workflows assume the repository is safe to mutate from the configured local clone.
- Routes resolve workflow paths relative to the task workspace, so use absolute paths in the task-orchestrator config unless the workflow files live inside the repo clone itself.
- The reporter only republishes milestones that the workflow policy allows. External sinks remain owned by the task orchestrator, not the individual agents.
- The issue/review workflows still use deterministic apply steps, but they now call Roboppi runtime commands rather than embedding `gh pr create` / `gh pr review` / `gh pr merge` directly in the workflow YAML.
