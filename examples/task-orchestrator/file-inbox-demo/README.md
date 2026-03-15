# file_inbox task-orchestrator demo

This demo proves that:

- `file_inbox` tasks are discovered and normalized
- routing selects a workflow
- task context is written under `context/_task/`
- the workflow receives `ROBOPPI_TASK_*` environment variables

## Run

```bash
bash examples/task-orchestrator/file-inbox-demo/run-in-tmp.sh
```

The script copies this demo to a scratch directory under `/tmp`, runs:

```bash
bun run src/cli.ts -- task-orchestrator run <tmp>/task-orchestrator.yaml
```

and then verifies:

- the workflow wrote the task id into `repo/task-id.txt`
- the file inbox source wrote an ack file under `inbox/.roboppi-acks/`
