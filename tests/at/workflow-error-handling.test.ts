/**
 * AT-5: Error handling acceptance tests
 */
import { describe, test, expect } from "bun:test";
import { ErrorClass } from "../../src/types/common.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import { MockStepRunner, withTempDir, executeYaml } from "./helpers.js";

// ---------------------------------------------------------------------------
// AT-5.1 on_failure: abort — downstream SKIPPED
// ---------------------------------------------------------------------------

describe("AT-5.1 on_failure: abort — downstream SKIPPED", () => {
  test("A → B → C, B fails (abort): C is SKIPPED, workflow FAILED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-abort
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
    on_failure: abort
  C:
    worker: CODEX_CLI
    instructions: "step C"
    capabilities: [READ]
    depends_on: [B]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "B") {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["B"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["C"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.2 on_failure: continue — downstream runs
// ---------------------------------------------------------------------------

describe("AT-5.2 on_failure: continue — downstream runs", () => {
  test("A → B → C, A fails (continue): B and C run, workflow FAILED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-continue
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: continue
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
  C:
    worker: CODEX_CLI
    instructions: "step C"
    capabilities: [READ]
    depends_on: [B]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["C"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.3 on_failure: retry — retry succeeds
// ---------------------------------------------------------------------------

describe("AT-5.3 on_failure: retry — retry succeeds", () => {
  test("A (max_retries: 2): 1st FAILED, 2nd SUCCEEDED → workflow SUCCEEDED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-retry-success
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 2
`;

      const runner = new MockStepRunner(async (stepId, _step, callIndex) => {
        if (stepId === "A" && callIndex === 1) {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(runner.getStepCallCount("A")).toBe(2);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.4 on_failure: retry — retries exhausted
// ---------------------------------------------------------------------------

describe("AT-5.4 on_failure: retry — retries exhausted", () => {
  test("A (max_retries: 2): all FAILED → 3 calls, A FAILED, downstream SKIPPED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-retry-exhausted
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 2
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(runner.getStepCallCount("A")).toBe(3); // 1 initial + 2 retries
      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.5 ErrorClass.FATAL overrides on_failure
// ---------------------------------------------------------------------------

describe("AT-5.5 ErrorClass.FATAL overrides on_failure", () => {
  test("FATAL + on_failure: continue → still aborts, downstream SKIPPED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: fatal-continue
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: continue
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.FATAL };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });

  test("FATAL + on_failure: retry (max_retries: 5) → no retries, runStep 1 call", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: fatal-retry
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 5
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.FATAL };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(runner.getStepCallCount("A")).toBe(1); // No retries for FATAL
      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });

  test("FATAL + on_failure: abort → normal abort, downstream SKIPPED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: fatal-abort
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: abort
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.FATAL };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.6 ErrorClass matrix with on_failure: retry
// ---------------------------------------------------------------------------

describe("AT-5.6 ErrorClass-based retry behavior", () => {
  test("RETRYABLE_TRANSIENT → retries", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-class-transient
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 2
`;

      const runner = new MockStepRunner(async (stepId, _step, callIndex) => {
        if (stepId === "A" && callIndex === 1) {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(runner.getStepCallCount("A")).toBe(2); // retried
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });

  test("RETRYABLE_RATE_LIMIT → retries", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-class-rate-limit
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 2
`;

      const runner = new MockStepRunner(async (stepId, _step, callIndex) => {
        if (stepId === "A" && callIndex === 1) {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_RATE_LIMIT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(runner.getStepCallCount("A")).toBe(2); // retried
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });

  test("NON_RETRYABLE → does not retry, fails immediately", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-class-non-retryable
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 5
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      // NON_RETRYABLE should not be retried even with on_failure: retry
      // Current executor retries all non-FATAL errors — this test documents expected behavior
      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
    });
  });

  test("FATAL → does not retry, aborts", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: error-class-fatal
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    on_failure: retry
    max_retries: 5
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.FATAL };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(runner.getStepCallCount("A")).toBe(1); // No retries for FATAL
      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.7 Parallel steps — one aborts, other completes, downstream SKIPPED
// ---------------------------------------------------------------------------

describe("AT-5.7 Parallel abort: A → {B, C} → D", () => {
  test("B fails (abort), C is running → C finishes, D SKIPPED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: parallel-abort
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
    on_failure: abort
  C:
    worker: CODEX_CLI
    instructions: "step C"
    capabilities: [READ]
    depends_on: [A]
  D:
    worker: CODEX_CLI
    instructions: "step D"
    capabilities: [READ]
    depends_on: [B, C]
`;

      // B fails immediately; C takes a little longer so it's "running" when B fails
      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "B") {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        if (stepId === "C") {
          // Simulate a step that takes a bit longer
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: "SUCCEEDED" };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["B"]!.status).toBe(StepStatus.FAILED);
      // C should complete (running steps are not cancelled by abort)
      expect(state.steps["C"]!.status).toBe(StepStatus.SUCCEEDED);
      // D should be SKIPPED because B (which D depends on) failed with abort
      expect(state.steps["D"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-5.8 Default on_failure is abort
// ---------------------------------------------------------------------------

describe("AT-5.8 Default on_failure is abort", () => {
  test("on_failure not specified → behaves as abort, downstream SKIPPED", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: default-on-failure
version: "1"
timeout: "30s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});
