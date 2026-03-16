import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import {
  isBunRuntime,
  resetChildBunStdinPipeProbeCache,
  supportsChildBunStdinPipe,
  usesBunChildRuntime,
} from "../../../src/workflow/supervised-ipc-capability.js";

function createMockChildProcess(
  onWrite: (input: string, stdout: PassThrough) => void,
): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new PassThrough();
  proc.kill = () => true;
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    onWrite(chunk, stdout);
  });
  stdin.on("end", () => {
    proc.emit("exit", 0, null);
  });
  return proc;
}

describe("isBunRuntime", () => {
  test("returns true for the Bun executable path", () => {
    expect(isBunRuntime("/home/reoring/.bun/bin/bun", {} as NodeJS.ProcessVersions)).toBe(true);
  });

  test("returns true for Bun-compiled binaries when process.versions.bun is present", () => {
    expect(
      isBunRuntime(
        "/usr/local/bin/roboppi",
        { bun: "1.3.6" } as NodeJS.ProcessVersions & { bun: string },
      ),
    ).toBe(true);
  });

  test("returns false for non-Bun runtimes", () => {
    expect(isBunRuntime("/usr/bin/node", {} as NodeJS.ProcessVersions)).toBe(false);
  });
});

describe("usesBunChildRuntime", () => {
  test("returns true when the supervised child entrypoint is a Bun script", () => {
    expect(
      usesBunChildRuntime(
        "/tmp/roboppi/src/index.ts",
        "/usr/bin/node",
        {} as NodeJS.ProcessVersions,
      ),
    ).toBe(true);
  });

  test("returns false when neither parent nor child use Bun", () => {
    expect(
      usesBunChildRuntime(
        "/usr/local/bin/roboppi",
        "/usr/bin/node",
        {} as NodeJS.ProcessVersions,
      ),
    ).toBe(false);
  });
});

describe("supportsChildBunStdinPipe", () => {
  test("returns true immediately for non-Bun child runtimes", async () => {
    await expect(
      supportsChildBunStdinPipe(
        "/usr/local/bin/roboppi",
        "/usr/bin/node",
        {} as NodeJS.ProcessVersions,
      ),
    ).resolves.toBe(true);
  });

  test("returns false for Bun-compiled binaries that cannot be safely probed with -e", async () => {
    await expect(
      supportsChildBunStdinPipe(
        "/usr/local/bin/roboppi",
        "/usr/local/bin/roboppi",
        { bun: "1.3.6" } as NodeJS.ProcessVersions & { bun: string },
      ),
    ).resolves.toBe(false);
  });

  test("returns true when node child_process stdio echoes the probe token", async () => {
    resetChildBunStdinPipeProbeCache();
    const spawnFn = () =>
      createMockChildProcess((input, stdout) => {
        stdout.write(input);
      });

    await expect(
      supportsChildBunStdinPipe(
        "/tmp/roboppi/src/index.ts",
        "/usr/bin/node",
        {} as NodeJS.ProcessVersions,
        spawnFn,
      ),
    ).resolves.toBe(true);
  });

  test("returns false when node child_process stdio never echoes the probe token", async () => {
    resetChildBunStdinPipeProbeCache();
    const spawnFn = () =>
      createMockChildProcess((_input, _stdout) => {
        // Simulate the hung stdio path: process exits without returning the token.
      });

    await expect(
      supportsChildBunStdinPipe(
        "/tmp/roboppi/src/index.ts",
        "/usr/bin/node",
        {} as NodeJS.ProcessVersions,
        spawnFn,
      ),
    ).resolves.toBe(false);
  });
});
