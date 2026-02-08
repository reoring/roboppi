#!/usr/bin/env bun
/**
 * Daemon CLI
 *
 * Usage:
 *   bun run src/daemon/cli.ts <daemon.yaml> [--verbose]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDaemonConfig } from "./parser.js";
import { Daemon } from "./daemon.js";

// -- Argument parsing --

const args = process.argv.slice(2);
let yamlPath = "";
let verbose = false;

for (const arg of args) {
  if (arg === "--verbose" || arg === "-v") {
    verbose = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: bun run src/daemon/cli.ts <daemon.yaml> [options]

Options:
  --verbose, -v   Enable verbose logging
  --help, -h      Show help`);
    process.exit(0);
  } else if (!arg.startsWith("-")) {
    yamlPath = arg;
  }
}

if (!yamlPath) {
  console.error("Error: daemon YAML path is required");
  console.error("Usage: bun run src/daemon/cli.ts <daemon.yaml>");
  process.exit(1);
}

// -- Main --

async function main(): Promise<void> {
  const resolvedPath = path.resolve(yamlPath);
  const yamlContent = await readFile(resolvedPath, "utf-8");
  const config = parseDaemonConfig(yamlContent);

  if (verbose) {
    console.log(`[cli] Config loaded from: ${resolvedPath}`);
  }

  const eventCount = Object.keys(config.events).length;
  const triggerCount = Object.keys(config.triggers).length;

  console.log(`Daemon: ${config.name}`);
  console.log(`Events: ${eventCount}`);
  console.log(`Triggers: ${triggerCount}`);
  console.log("");

  const daemon = new Daemon(config);
  await daemon.start();
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
