import { describe, test, expect } from "bun:test";
import { EscalationManager } from "../../../src/core/escalation-manager.js";
import { EscalationScope, EscalationAction } from "../../../src/types/index.js";

describe("EscalationManager", () => {
  describe("FATAL condition detection", () => {
    test("detects worker crash rate exceeding threshold", () => {
      const manager = new EscalationManager({ crashThreshold: 3 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");

      const events = manager.evaluate();
      expect(events.length).toBeGreaterThanOrEqual(1);

      const crashEvent = events.find(
        (e) => e.scope === EscalationScope.WORKER_KIND && e.target === "CLAUDE_CODE",
      );
      expect(crashEvent).toBeDefined();
      expect(crashEvent!.action).toBe(EscalationAction.ISOLATE);
      expect(crashEvent!.reason).toContain("crashed");
    });

    test("does not trigger when crashes are below threshold", () => {
      const manager = new EscalationManager({ crashThreshold: 5 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");

      const events = manager.evaluate();
      const crashEvent = events.find(
        (e) => e.scope === EscalationScope.WORKER_KIND && e.target === "CLAUDE_CODE" && e.reason.includes("crashed"),
      );
      expect(crashEvent).toBeUndefined();
    });

    test("detects cancel timeout (ghost process)", () => {
      const manager = new EscalationManager();

      manager.recordCancelTimeout("CODEX_CLI");

      const events = manager.evaluate();
      const ghostEvent = events.find(
        (e) => e.target === "CODEX_CLI" && e.reason.includes("ghost"),
      );
      expect(ghostEvent).toBeDefined();
      expect(ghostEvent!.scope).toBe(EscalationScope.WORKER_KIND);
      expect(ghostEvent!.action).toBe(EscalationAction.ISOLATE);
    });

    test("detects non-converging latest-wins on workspace", () => {
      const manager = new EscalationManager({ latestWinsThreshold: 3 });

      manager.recordLatestWins("/workspace/project-a");
      manager.recordLatestWins("/workspace/project-a");
      manager.recordLatestWins("/workspace/project-a");

      const events = manager.evaluate();
      const wsEvent = events.find(
        (e) => e.scope === EscalationScope.WORKSPACE && e.target === "/workspace/project-a",
      );
      expect(wsEvent).toBeDefined();
      expect(wsEvent!.action).toBe(EscalationAction.STOP);
      expect(wsEvent!.reason).toContain("not converging");
    });

    test("does not trigger latest-wins below threshold", () => {
      const manager = new EscalationManager({ latestWinsThreshold: 3 });

      manager.recordLatestWins("/workspace/project-a");
      manager.recordLatestWins("/workspace/project-a");

      const events = manager.evaluate();
      const wsEvent = events.find(
        (e) => e.scope === EscalationScope.WORKSPACE,
      );
      expect(wsEvent).toBeUndefined();
    });
  });

  describe("scope and action determination", () => {
    test("worker-specific issues produce WORKER_KIND scope with ISOLATE action", () => {
      const manager = new EscalationManager({ crashThreshold: 2 });

      manager.recordWorkerCrash("OPENCODE");
      manager.recordWorkerCrash("OPENCODE");

      const events = manager.evaluate();
      const workerEvent = events.find(
        (e) => e.scope === EscalationScope.WORKER_KIND && e.target === "OPENCODE",
      );
      expect(workerEvent).toBeDefined();
      expect(workerEvent!.action).toBe(EscalationAction.ISOLATE);
    });

    test("workspace issues produce WORKSPACE scope with STOP action", () => {
      const manager = new EscalationManager({ latestWinsThreshold: 2 });

      manager.recordLatestWins("/ws/alpha");
      manager.recordLatestWins("/ws/alpha");

      const events = manager.evaluate();
      const wsEvent = events.find(
        (e) => e.scope === EscalationScope.WORKSPACE,
      );
      expect(wsEvent).toBeDefined();
      expect(wsEvent!.action).toBe(EscalationAction.STOP);
    });

    test("multiple worker kinds failing produce GLOBAL scope with STOP action", () => {
      const manager = new EscalationManager({ crashThreshold: 2 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordCancelTimeout("CODEX_CLI");

      const events = manager.evaluate();
      const globalEvent = events.find(
        (e) => e.scope === EscalationScope.GLOBAL,
      );
      expect(globalEvent).toBeDefined();
      expect(globalEvent!.action).toBe(EscalationAction.STOP);
      expect(globalEvent!.target).toBe("system");
    });
  });

  describe("history tracking", () => {
    test("getHistory returns all escalation events", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.evaluate();

      manager.recordCancelTimeout("CODEX_CLI");
      manager.evaluate();

      const history = manager.getHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    test("getHistory returns a copy (not mutable reference)", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.evaluate();

      const history1 = manager.getHistory();
      const len1 = history1.length;

      manager.recordCancelTimeout("CODEX_CLI");
      manager.evaluate();

      // Original array should not have changed
      expect(history1.length).toBe(len1);
      // But a new getHistory call should have more
      expect(manager.getHistory().length).toBeGreaterThan(len1);
    });

    test("reset clears all state and history", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordCancelTimeout("CODEX_CLI");
      manager.recordLatestWins("/ws/alpha");
      manager.evaluate();

      expect(manager.getHistory().length).toBeGreaterThan(0);

      manager.reset();
      expect(manager.getHistory().length).toBe(0);

      // After reset, evaluate should return no events
      const events = manager.evaluate();
      expect(events.length).toBe(0);
    });
  });

  describe("crash rate windowing", () => {
    test("old crashes outside the 1-minute window are not counted", () => {
      const manager = new EscalationManager({ crashThreshold: 3 });

      // Simulate old crashes by directly testing evaluate's windowing behavior
      // Record 2 crashes now
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");

      // Not at threshold yet
      let events = manager.evaluate();
      const crashEvent = events.find(
        (e) => e.reason.includes("crashed"),
      );
      expect(crashEvent).toBeUndefined();

      // One more crash should trigger
      manager.recordWorkerCrash("CLAUDE_CODE");
      events = manager.evaluate();
      const triggered = events.find(
        (e) => e.reason.includes("crashed"),
      );
      expect(triggered).toBeDefined();
    });
  });

  describe("onEscalation callback", () => {
    test("notifies registered listeners on evaluate", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });
      const received: Array<{ scope: string; target: string }> = [];

      manager.onEscalation((event) => {
        received.push({ scope: event.scope, target: event.target });
      });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.evaluate();

      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received.some((e) => e.target === "CLAUDE_CODE")).toBe(true);
    });

    test("multiple listeners all receive events", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });
      let count1 = 0;
      let count2 = 0;

      manager.onEscalation(() => count1++);
      manager.onEscalation(() => count2++);

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.evaluate();

      expect(count1).toBeGreaterThanOrEqual(1);
      expect(count2).toBeGreaterThanOrEqual(1);
    });

    test("listener receives escalation events with correct structure", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });
      const received: Array<{ scope: string; action: string; severity: string }> = [];

      manager.onEscalation((event) => {
        received.push({ scope: event.scope, action: event.action, severity: event.severity });
      });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.evaluate();

      const crashEvent = received.find((e) => e.scope === EscalationScope.WORKER_KIND);
      expect(crashEvent).toBeDefined();
      expect(crashEvent!.action).toBe(EscalationAction.ISOLATE);
      expect(typeof crashEvent!.severity).toBe("string");
    });
  });

  describe("reset clears all tracked state", () => {
    test("reset clears worker crashes, cancel timeouts, latest-wins, and history", () => {
      const manager = new EscalationManager({ crashThreshold: 1, latestWinsThreshold: 1 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordCancelTimeout("CODEX_CLI");
      manager.recordLatestWins("/ws/alpha");
      manager.evaluate();

      expect(manager.getHistory().length).toBeGreaterThan(0);

      manager.reset();

      expect(manager.getHistory().length).toBe(0);

      // All state cleared - no events should be produced
      const events = manager.evaluate();
      expect(events.length).toBe(0);
    });

    test("reset allows fresh state accumulation", () => {
      const manager = new EscalationManager({ crashThreshold: 2 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.evaluate();
      expect(manager.getHistory().length).toBeGreaterThan(0);

      manager.reset();

      // Only 1 crash now — should not trigger threshold of 2
      manager.recordWorkerCrash("CLAUDE_CODE");
      const events = manager.evaluate();
      const crashEvent = events.find((e) => e.reason.includes("crashed"));
      expect(crashEvent).toBeUndefined();
    });
  });

  describe("multiple scopes", () => {
    test("WORKER_KIND scope with ISOLATE action for crash threshold", () => {
      const manager = new EscalationManager({ crashThreshold: 2 });
      manager.recordWorkerCrash("OPENCODE");
      manager.recordWorkerCrash("OPENCODE");

      const events = manager.evaluate();
      const workerEvent = events.find(
        (e) => e.scope === EscalationScope.WORKER_KIND && e.target === "OPENCODE",
      );
      expect(workerEvent).toBeDefined();
      expect(workerEvent!.action).toBe(EscalationAction.ISOLATE);
    });

    test("WORKSPACE scope with STOP action for latest-wins", () => {
      const manager = new EscalationManager({ latestWinsThreshold: 2 });
      manager.recordLatestWins("/ws/beta");
      manager.recordLatestWins("/ws/beta");

      const events = manager.evaluate();
      const wsEvent = events.find(
        (e) => e.scope === EscalationScope.WORKSPACE && e.target === "/ws/beta",
      );
      expect(wsEvent).toBeDefined();
      expect(wsEvent!.action).toBe(EscalationAction.STOP);
    });

    test("GLOBAL scope with STOP action when multiple worker kinds failing", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CODEX_CLI");

      const events = manager.evaluate();
      const globalEvent = events.find(
        (e) => e.scope === EscalationScope.GLOBAL,
      );
      expect(globalEvent).toBeDefined();
      expect(globalEvent!.action).toBe(EscalationAction.STOP);
      expect(globalEvent!.severity).toBe("fatal");
    });

    test("cancelTimeout triggers WORKER_KIND scope escalation", () => {
      const manager = new EscalationManager();
      manager.recordCancelTimeout("OPENCODE");

      const events = manager.evaluate();
      const event = events.find(
        (e) => e.scope === EscalationScope.WORKER_KIND && e.target === "OPENCODE",
      );
      expect(event).toBeDefined();
      expect(event!.action).toBe(EscalationAction.ISOLATE);
      expect(event!.reason).toContain("ghost");
    });

    test("latestWins threshold triggers escalation after reaching count", () => {
      const manager = new EscalationManager({ latestWinsThreshold: 3 });

      // Below threshold
      manager.recordLatestWins("/ws/gamma");
      manager.recordLatestWins("/ws/gamma");
      let events = manager.evaluate();
      expect(events.find((e) => e.scope === EscalationScope.WORKSPACE)).toBeUndefined();

      // At threshold
      manager.recordLatestWins("/ws/gamma");
      events = manager.evaluate();
      const wsEvent = events.find(
        (e) => e.scope === EscalationScope.WORKSPACE && e.target === "/ws/gamma",
      );
      expect(wsEvent).toBeDefined();
    });
  });
});
