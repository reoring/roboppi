#!/usr/bin/env bun
/**
 * Daemon CLI
 *
 * Usage:
 *   bun run src/daemon/cli.ts <daemon.yaml> [--workspace <dir>] [--verbose]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDaemonConfig } from "./parser.js";
import { Daemon } from "./daemon.js";

// -- Argument parsing --

const args = process.argv.slice(2);
let yamlPath = "";
let verbose = false;
let workspaceOverride = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  const next = (): string => {
    i++;
    const val = args[i];
    if (val === undefined) {
      console.error(`Error: ${arg} requires a value`);
      process.exit(1);
    }
    return val;
  };

  if (arg === "--verbose" || arg === "-v") {
    verbose = true;
  } else if (arg === "--workspace" || arg === "-w") {
    workspaceOverride = next();
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: bun run src/daemon/cli.ts <daemon.yaml> [options]

Options:
  --workspace, -w <dir>  Override workspace directory
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
  const parsed = parseDaemonConfig(yamlContent);

  const config = applyWorkspaceOverride(expandEnvInConfig(parsed), workspaceOverride);

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

function expandEnvString(value: string, field: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`Env var \${${name}} referenced in ${field} is not set`);
    }
    return v;
  });
}

function expandEnvInConfig(config: ReturnType<typeof parseDaemonConfig>): ReturnType<typeof parseDaemonConfig> {
  const expanded = {
    ...config,
    workspace: expandEnvString(config.workspace, "workspace"),
    state_dir: config.state_dir ? expandEnvString(config.state_dir, "state_dir") : undefined,
    log_dir: config.log_dir ? expandEnvString(config.log_dir, "log_dir") : undefined,
    triggers: Object.fromEntries(
      Object.entries(config.triggers).map(([id, t]) => [
        id,
        {
          ...t,
          workflow: expandEnvString(t.workflow, `triggers.${id}.workflow`),
        },
      ]),
    ) as typeof config.triggers,
  };
  return expanded;
}

function applyWorkspaceOverride(config: ReturnType<typeof parseDaemonConfig>, workspaceOverrideValue: string): ReturnType<typeof parseDaemonConfig> {
  if (!workspaceOverrideValue) return config;
  return {
    ...config,
    workspace: expandEnvString(workspaceOverrideValue, "--workspace"),
  };
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
