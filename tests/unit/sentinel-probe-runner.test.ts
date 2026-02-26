/**
 * Unit tests: ProbeRunner
 */
import { describe, test, expect } from "bun:test";
import { ProbeRunner } from "../../src/workflow/sentinel/probe-runner.js";

describe("ProbeRunner", () => {
  test("run probe that outputs valid JSON - parses correctly", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing","summary":{"files":3}}\'',
      5000,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output!.class).toBe("progressing");
    expect(result.output!.summary).toEqual({ files: 3 });
    expect(result.digest).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  test("run probe that outputs invalid JSON - returns error", async () => {
    const runner = new ProbeRunner("echo 'not json'", 5000);

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.error).toBe("probe output is not valid JSON");
    expect(result.digest).toBe("");
    expect(result.output).toBeUndefined();
  });

  test("probe with explicit digest field uses it", async () => {
    const runner = new ProbeRunner(
      'echo \'{"digest":"custom-digest-123","class":"stalled"}\'',
      5000,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.digest).toBe("custom-digest-123");
  });

  test("probe without digest field computes hash", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing","value":42}\'',
      5000,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    // digest should be a computed hex hash (16 chars)
    expect(result.digest).toMatch(/^[0-9a-f]{16}$/);

    // Running the same probe again should produce the same digest
    const result2 = await runner.run();
    expect(result2.digest).toBe(result.digest);
  });

  test("probe stderr is captured on failure", async () => {
    const runner = new ProbeRunner(
      'echo "not json" && echo "error detail" >&2',
      5000,
    );

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.stderr).toContain("error detail");
  });

  test("probe exit code is captured", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing"}\' && exit 0',
      5000,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("probe non-zero exit code is captured on failure", async () => {
    const runner = new ProbeRunner("exit 42", 5000);

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  test("successful probe omits stderr", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing"}\'',
      5000,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.stderr).toBeUndefined();
  });

  test("probe with require_zero_exit=true and exit_code=0 succeeds", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing"}\' && exit 0',
      5000,
      undefined,
      true,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBeDefined();
    expect(result.output!.class).toBe("progressing");
  });

  test("probe with require_zero_exit=true and non-zero exit fails", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing"}\' && exit 1',
      5000,
      undefined,
      true,
    );

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("require_zero_exit");
  });

  test("probe with require_zero_exit=true and non-zero exit still includes parsed output", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing","summary":{"files":5}}\' && exit 1',
      5000,
      undefined,
      true,
    );

    const result = await runner.run();

    expect(result.success).toBe(false);
    expect(result.output).toBeDefined();
    expect(result.output!.class).toBe("progressing");
    expect(result.output!.summary).toEqual({ files: 5 });
  });

  test("probe with require_zero_exit=false (default) and non-zero exit succeeds", async () => {
    const runner = new ProbeRunner(
      'echo \'{"class":"progressing"}\' && exit 1',
      5000,
      undefined,
      false,
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBeDefined();
  });

  test("probe inherits custom env", async () => {
    const runner = new ProbeRunner(
      'echo \'{"value":"\'$SENTINEL_TEST_VAR\'"}\'',
      5000,
      undefined,
      false,
      { SENTINEL_TEST_VAR: "hello-from-env" },
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect((result.output as Record<string, unknown>).value).toBe("hello-from-env");
  });

  test("probe env merges with process.env", async () => {
    // PATH should still be available (inherited from process.env)
    const runner = new ProbeRunner(
      'echo \'{"has_path":"\'$(test -n "$PATH" && echo yes || echo no)\'"}\'',
      5000,
      undefined,
      false,
      { CUSTOM_VAR: "test" },
    );

    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect((result.output as Record<string, unknown>).has_path).toBe("yes");
  });

  test("probe timeout kills process", async () => {
    // Use a very short timeout with a command that would take forever
    const runner = new ProbeRunner("sleep 60", 200);

    const startTime = Date.now();
    const result = await runner.run();
    const elapsed = Date.now() - startTime;

    // Should fail due to timeout or empty output
    // The probe is killed, so it either fails to parse or returns error
    expect(result.success).toBe(false);
    // Should complete relatively quickly (within a few seconds)
    expect(elapsed).toBeLessThan(5000);
  });
});
