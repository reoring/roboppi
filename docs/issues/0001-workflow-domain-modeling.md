# Workflow Domain Modeling Gap (Coupled to YAML schema / Scattered normalization & validation)

Status: proposal

## Problem

After `parseWorkflow()` reads the workflow YAML, the resulting structure is used directly as the runtime domain model.
As a result, the boundaries between "configuration (config)", "execution plan (compiled/resolved)", and "execution results (runtime state)" are blurry, and transformations/validation tend to be spread across multiple layers.

Concrete symptoms:

- Similar normalization logic is duplicated across both supervised and non-supervised paths
  - e.g. duration parsing for `timeout`, `path.resolve()` for `workspace`, budget assembly
  - Similar logic exists in `src/workflow/multi-worker-step-runner.ts` and `src/workflow/core-ipc-step-runner.ts`
- Validation is scattered across multiple places, making it easy for behavior to diverge whenever the spec evolves
  - `src/workflow/parser.ts` (schema/field validation)
  - `src/workflow/dag-validator.ts` (DAG consistency + partial safety checks)
  - `src/workflow/executor.ts` (runtime safety/convergence/infra-failure guards)
- `WORKER_TASK` over Core IPC has a weak payload type contract
  - Core relies on casts like `job.payload as { ... }` (see `src/core/agentcore.ts`)
  - Runner/Core do not share a typed contract for expected fields, so breaking changes can slip in more easily

## Current Structure (Summary)

- YAML -> `WorkflowDefinition` / `StepDefinition` (`src/workflow/types.ts`)
- Runner: load/parse/validateDag -> feed into `WorkflowExecutor` (`src/workflow/run.ts`)
- Executor: DAG state management + loop (`completion_check`) + convergence guards, etc. (`src/workflow/executor.ts`)
- Step execution: delegated to the `StepRunner` port
  - direct spawn: `MultiWorkerStepRunner` (`src/workflow/multi-worker-step-runner.ts`)
  - supervised: `CoreIpcStepRunner` (`src/workflow/core-ipc-step-runner.ts`)

This split is healthy, but the lack of separation between "YAML types" and "resolved execution model" is the root cause of duplication and dispersion.

## Root Causes

1) `StepDefinition` is used as both "user input (YAML)" and "execution plan (resolved)"

2) Normalization (duration/path/capabilities/budget/env) is repeatedly performed in each StepRunner

3) IPC payload types are not shared between Core and Runner, leaving the boundary as an implicit contract

## Goals

- Separate configuration (YAML) from execution plan (resolved/compiled), and consolidate normalization/validation into a single path
- Guarantee identical resolved results (timeout/workspace/budget, etc.) across supervised and non-supervised execution
- Fix the Core IPC `WORKER_TASK` payload contract as a shared type so breaking changes are caught at build time
- Preserve backwards compatibility with existing YAML (no breaking changes)

## Proposal

### 1) Introduce a Resolved/Compiled Workflow model

Produce a resolved execution model from `WorkflowDefinition` (YAML schema).

Example (conceptual):

- `ResolvedWorkflow`:
  - `workflowTimeoutMs: number`
  - `steps: Record<string, ResolvedStep>`
- `ResolvedStep`:
  - `stepId: string`
  - `workerKind: WorkerKind` (runtime enum, not a raw string like `"OPENCODE"`)
  - `workspaceRef: string` (absolute path)
  - `timeoutMs: number`
  - `budget: { deadlineAt: number; maxSteps?; maxCommandTimeMs? }`
  - `capabilities: WorkerCapability[]` (runtime enum list, not raw strings)
  - `model?: string`
  - `completionCheck?: ResolvedCheck`

`WorkflowExecutor` and StepRunners consume this compiled model, and StepRunners no longer do duration/path resolving.

### 2) Re-organize the validation pipeline

Split validation into: "schema validation", "semantic validation", and "runtime safety validation", and make responsibilities explicit.

- Schema validation: `parser.ts`
- Semantic validation: DAG, `depends_on`/inputs consistency, `completion_check` + `max_iterations`, etc.
- Runtime safety validation: drift/convergence/infra failure, etc. (`executor`)

At minimum, static constraints like DAG and `max_iterations` should run only once before generating the compiled model.

### 3) Share the Core IPC `WORKER_TASK` payload type

Share the same type/validator for the payload sent by `CoreIpcStepRunner` and received by Core.

Example:

- Add `src/types/worker-task-payload.ts`
- `CoreIpcStepRunner` constructs a `WorkerTaskJobPayload`
- `AgentCore.executeWorkerTask` validates via a type guard and avoids `as { ... }`

### 4) Observability: persist resolved values as artifacts

Persist resolved timeout/budget/workspaceRef/model/agent (minimum necessary) into artifacts like `context/_workflow.json` and `context/<step>/_meta.json`, so the effective settings can be reconstructed after the run.

## Implementation Tasks (Phased)

### Phase 0: Nail down the spec/boundaries (keep it small)

- [ ] Decide the shape of the resolved model
  - Recommended: keep `timeoutMs`, and compute `deadlineAt = now + timeoutMs` right before step execution (so long workflows do not drift timeouts)
- [ ] Decide the default timeout for `completion_check`
  - Recommended: if `check.timeout` is not specified, use `step.timeoutMs / 4` (aligned with existing docs). If compatibility risk exists, gate with a backwards-compat flag
- [ ] Fix where agent catalog resolution happens
  - Recommended: keep resolving at parse time (`src/workflow/parser.ts`), and keep resolved/compiled focused on execution normalization

### Phase 1: Consolidate normalization in one place (introduce a shared resolver)

- [ ] Add `src/workflow/resolve-worker-task.ts` (name is flexible)
  - Implement `resolveTaskLike(def, workspaceRoot, env)`
    - duration string -> ms (`timeoutMs`, `maxCommandTimeMs`)
    - `workspace` -> `workspaceRef` (`path.resolve`)
    - capability string[] -> `WorkerCapability[]`
    - `worker` -> `WorkerKind`
    - apply `model` / `instructions` / `env`
  - Implement `buildWorkerTask(resolved, abortSignal)` (`deadlineAt = now + timeoutMs`)
- [ ] Add unit tests: `test/unit/workflow/resolve-worker-task.test.ts`
  - duration parsing / workspace resolving / capability mapping / default timeout

### Phase 2: Remove StepRunner duplication (replace with the resolver)

- [ ] Replace `src/workflow/multi-worker-step-runner.ts` to use the resolver
  - remove duplicated `buildWorkerTask` / ad-hoc type definitions
- [ ] Replace `src/workflow/core-ipc-step-runner.ts` to use the resolver
  - remove duplicated `ResolvedWorkerTaskDef` / conversion logic
- [ ] Add tests ensuring "same StepDefinition -> same resolved spec" across both runners
  - e.g. compare only resolved fields (exclude `workerTaskId` / `deadlineAt`)

### Phase 3: Lock the Core IPC boundary type contract (shared payload + validation)

- [ ] Add `src/types/worker-task-job-payload.ts` (name is flexible)
  - `WorkerTaskJobPayload` type + a type guard (at minimum: required fields presence and types)
- [ ] In `src/workflow/core-ipc-step-runner.ts`, build payload as `WorkerTaskJobPayload`
- [ ] In `src/core/agentcore.ts`, validate the payload via a type guard and remove `as { ... }`
  - invalid payload must reliably terminate as `job_completed(outcome=failed, errorClass=NON_RETRYABLE)` (avoid hangs)
- [ ] Add tests
  - invalid payload fail-fast in Core; no hang or unfinished state

### Phase 4: (Optional) Promote to a Compiled Workflow model

- [ ] Introduce `ResolvedWorkflow` / `ResolvedStepStatic` to resolve static fields ahead of time
  - Note: `instructions` can change dynamically due to convergence logic, so apply instructions each iteration (exclude from static resolution)
- [ ] Refine boundaries between Executor/Runner and share a single resolved model

### Phase 5: Observability/artifacts (persist resolved values)

- [ ] Record resolved values (timeoutMs/workspaceRef/workerKind/model, etc.) minimally into `context/<step>/_meta.json`
- [ ] Update docs (this issue + relevant parts of `docs/guide/workflow.md`)

## Acceptance Criteria

- duration/path/budget/capabilities resolution logic is consolidated into a single place
- normalization logic is removed from both `MultiWorkerStepRunner` and `CoreIpcStepRunner` (they only execute compiled models)
- Core validates typed payload and the Runner/Core contract is explicit
- existing examples work and `make typecheck` / `make test` pass

## References (Current code)

- YAML parse / schema: `src/workflow/parser.ts`, `src/workflow/types.ts`
- DAG validation: `src/workflow/dag-validator.ts`
- Executor: `src/workflow/executor.ts`
- StepRunner (direct): `src/workflow/multi-worker-step-runner.ts`
- StepRunner (supervised): `src/workflow/core-ipc-step-runner.ts`
- Core worker delegation: `src/core/agentcore.ts`
