# github_issue task-orchestrator demo

This demo exercises the `github_issue` source locally without network access.

It prepends a fake `gh` executable to `PATH`, so the task orchestrator runs its
real `gh api` integration but receives fixture JSON instead of calling GitHub.
The demo workflow also declares a small agent team in `workflow.yaml`:

- `lead` orchestrates the issue workflow
- `reporter` emits internal task activity
- `reporting.sinks.github` declares that only `reporter` activity should be projected into the GitHub status comment

## Run

```bash
bash examples/task-orchestrator/github-issue-demo/run-with-fake-gh.sh
```

The script verifies that:

- `github_issue` tasks are listed through `gh api`
- pull requests in the issue listing are ignored
- issue details are normalized into task context
- the workflow receives the normalized `github:issue:<repo>#<number>` task id
- the workflow auto-loads `workflows/agents.yaml`
- the `reporter` agent emits task activity without calling GitHub directly
- resident `serve` mode projects that activity into a GitHub issue status comment
- the workflow writes `context/_task/landing.json`, producing a final `ready_to_land` state
- task completion is acked back to GitHub by posting an issue comment

## Real GitHub usage

For a real repository, remove the fake `gh` wrapper and make sure `gh` is already authenticated:

```bash
gh auth login
gh auth status
gh api repos/<owner>/<repo>/issues
```

Or provide a token for `gh`:

```bash
export GH_TOKEN=...
# or
export GITHUB_TOKEN=...
```

For source ack to succeed, that credential also needs permission to create issue comments.
For status projection in resident `serve` mode, the same credential is used to
create or update the status comment.

This demo exists to validate the source implementation locally without depending on network access.
