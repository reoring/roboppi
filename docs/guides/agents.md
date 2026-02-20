# Agent Catalogs (Reusable Agent Profiles)

Workflows often repeat the same “agent settings” across steps:

- worker kind (OPENCODE / CLAUDE_CODE / CODEX_CLI / CUSTOM)
- model
- default capabilities
- base instructions (a shared system prompt)

Roboppi lets you define these once in an external YAML file (an **agent catalog**) and reference them from workflow steps via `agent: <id>`.

## 1) Agent catalog file

Create a YAML file like `agents.yaml`:

```yaml
version: "1"
agents:
  research:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      You are a research agent.
      Only read files. Do not edit.
```

## 2) Reference from a workflow

```yaml
steps:
  investigate:
    agent: research
    instructions: |
      Investigate the codebase and write a short report.
    outputs:
      - name: report
        path: docs/research.md
```

`completion_check` can also reference an agent:

```yaml
completion_check:
  agent: research
  instructions: "Decide COMPLETE or INCOMPLETE"
  decision_file: ".roboppi-loop/decision.json"
```

## 3) Resolution rules

- If `agent` is set, missing fields in the step/check are filled from the agent profile (`worker`, `model`, `capabilities`, `workspace`, `timeout`, `max_steps`, `max_command_time`).
- If the agent defines `base_instructions`, it is prepended before `instructions`.
- Step/check values override profile defaults.

## 4) How catalogs are loaded

Workflow runner:

- Explicit: `ROBOPPI_AGENTS_FILE=/a.yaml:/b.yaml` (colon-separated) and/or `--agents <path>` (repeatable)
- Implicit: if no explicit paths are provided, auto-load `agents.yaml` / `agents.yml` next to the workflow YAML

Daemon:

- Daemon config can set `agents_file: "./agents.yaml"` (relative to `workspace`)
- You can also set `ROBOPPI_AGENTS_FILE` globally or per-trigger via `triggers.<id>.context.env`

When multiple catalogs define the same agent id, later sources override earlier ones.
