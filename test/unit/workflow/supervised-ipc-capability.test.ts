import { describe, test, expect } from "bun:test";

import {
  isBunRuntime,
  supportsChildBunStdinPipe,
  usesBunChildRuntime,
} from "../../../src/workflow/supervised-ipc-capability.js";

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
});
