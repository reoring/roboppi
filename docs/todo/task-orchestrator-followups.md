# Task-Orchestrator Follow-ups

Status: active

This file tracks post-v1 work that is already designed but not fully implemented.

## In progress

- [ ] GitHub operator comments -> agent lead inbox
  - [x] Bridge new human GitHub comments into `_agents` mailbox as `operator_comment`
  - [x] Teach the live agent-team examples to consume `operator_comment`
  - [ ] Add live verification for clarification reply -> lead inbox -> resumed work

## Next

- [ ] Tighten clarification responder filtering
  - [ ] Distinguish issue author / collaborator / maintainer
  - [ ] Ignore non-authorized human comments for auto-resume

- [ ] Clarification provider policy
  - [ ] Optional `needs-info` label on clarification request
  - [ ] Final blocked comment when `block_after` expires
  - [ ] Optional reminder cadence beyond the first reminder

- [ ] Formal review identity split
  - [ ] Support separate reviewer credential for GitHub approval
  - [ ] Remove self-review fallback from the happy path example

- [ ] Linear bridge
  - [ ] Declarative reporting sink implementation
  - [ ] Clarification / waiting-state projection parity with GitHub
