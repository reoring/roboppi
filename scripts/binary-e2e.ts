/**
 * E2E demo: agentcore run subcommand.
 *
 * Demonstrates the built binary executing a one-shot worker task
 * via CLI arguments — no driver script or IPC needed.
 */

export {};

const WORKSPACE = "/tmp/agentcore-binary-demo";
const log = (msg: string) => console.log(`[demo] ${msg}`);

log("=== AgentCore Binary E2E Demo ===\n");

// Clean workspace
await Bun.$`rm -rf ${WORKSPACE} && mkdir -p ${WORKSPACE}`.quiet();
log(`Workspace: ${WORKSPACE}`);

// Run agentcore with the "run" subcommand
const instructions =
  "Create countdown.ts. It should accept a number N via CLI args, count down from N, then print Liftoff!. Example: bun run countdown.ts 5 -> 5,4,3,2,1,Liftoff!";

log(`\nRunning: ./agentcore run --worker opencode --workspace ${WORKSPACE} "${instructions.slice(0, 60)}..."\n`);

const startTime = Date.now();
const proc = Bun.spawn(
  ["./agentcore", "run", "--worker", "opencode", "--workspace", WORKSPACE, instructions],
  { stdout: "pipe", stderr: "inherit" },
);

await proc.exited;
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const status = proc.exitCode === 0 ? "SUCCESS" : "FAILED";

log(`\nResult: ${status} (${elapsed}s)`);

// Show what was created
log("\n--- Files created ---");
const ls = Bun.spawn(["find", WORKSPACE, "-type", "f", "-not", "-path", "*/.*"], { stdout: "pipe" });
const files = (await new Response(ls.stdout).text()).trim();
for (const f of files.split("\n").filter(Boolean)) {
  const name = f.replace(`${WORKSPACE}/`, "");
  const content = await Bun.file(f).text();
  log(`\n[${name}]`);
  log(content.trimEnd());
}

// Run the created program
log("\n\n--- Running countdown.ts ---");
try {
  const run = Bun.spawn(["bun", "run", "countdown.ts", "5"], {
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(run.stdout).text();
  await run.exited;
  log(output.trimEnd());
} catch (err) {
  log(`(could not run: ${err})`);
}

log("\n=== Demo Complete ===");
process.exit(0);
