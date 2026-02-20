#!/usr/bin/env bun
/**
 * Daemon CLI
 *
 * Usage:
 *   roboppi daemon <daemon.yaml> [--workspace <dir>] [--verbose] [--direct]
 *   (dev) bun run src/daemon/cli.ts <daemon.yaml> [--workspace <dir>] [--verbose] [--direct]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDaemonConfig } from "./parser.js";
import { Daemon } from "./daemon.js";
import { applyEnvPrefixAliases } from "../core/env-aliases.js";

function isNonInteractive(): boolean {
  // Treat either stream being a TTY as interactive.
  return !(process.stdout.isTTY || process.stderr.isTTY);
}

function isRunningUnderBun(): boolean {
  const base = path.basename(process.execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

function resolveCoreEntryPointForSupervised(coreEntryPointOverride: string | undefined): string {
  const fromCli = coreEntryPointOverride?.trim();
  if (fromCli) return fromCli;

  const fromEnv = (process.env.ROBOPPI_CORE_ENTRYPOINT ?? process.env.AGENTCORE_CORE_ENTRYPOINT)?.trim();
  if (fromEnv) return fromEnv;

  // Compiled binary: spawn this executable as the Core process.
  if (!isRunningUnderBun()) return process.execPath;

  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "index.ts",
  );
}

export async function runDaemonCli(argv: string[]): Promise<void> {
  applyEnvPrefixAliases();

  const args = argv;
  let yamlPath = "";
  let verbose = false;
  let workspaceOverride = "";
  let supervised = true;
  let coreEntryPointOverride: string | undefined;

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
    } else if (arg === "--supervised") {
      supervised = true;
    } else if (arg === "--direct" || arg === "--no-supervised") {
      supervised = false;
    } else if (arg === "--core" || arg === "--core-entrypoint") {
      coreEntryPointOverride = next();
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  roboppi daemon <daemon.yaml> [options]
  (dev) bun run src/daemon/cli.ts <daemon.yaml> [options]

Options:
  --workspace, -w <dir>  Override workspace directory
  --verbose, -v   Enable verbose logging
  --supervised     Supervised mode (default): run workflows via Core IPC (Supervisor -> Core -> Worker)
  --direct         Direct mode: spawn worker CLIs directly (no Core IPC)
  --no-supervised  Alias for --direct
  --core <path|cmd>  Core entrypoint for supervised mode (default: auto)
  --help, -h      Show help`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      yamlPath = arg;
    }
  }

  if (verbose) {
    process.env.ROBOPPI_VERBOSE = "1";
    process.env.AGENTCORE_VERBOSE = "1";
  }

  // Default supervised IPC transport.
  // Mirror workflow runner behavior: prefer socket transport in non-interactive mode.
  // (Override via ROBOPPI_SUPERVISED_IPC_TRANSPORT or AGENTCORE_SUPERVISED_IPC_TRANSPORT.)
  if (
    supervised &&
    process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT === undefined &&
    process.env.AGENTCORE_SUPERVISED_IPC_TRANSPORT === undefined
  ) {
    const val = isNonInteractive() ? "socket" : "stdio";
    process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT = val;
    process.env.AGENTCORE_SUPERVISED_IPC_TRANSPORT = val;
  }

  if (!yamlPath) {
    console.error("Error: daemon YAML path is required");
    console.error("Usage: roboppi daemon <daemon.yaml> [options]");
    process.exit(1);
  }

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

  const daemon = new Daemon(
    config,
    undefined,
    supervised
      ? { supervised, coreEntryPoint: resolveCoreEntryPointForSupervised(coreEntryPointOverride) }
      : { supervised },
  );
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
    agents_file: config.agents_file ? expandEnvString(config.agents_file, "agents_file") : undefined,
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

if (import.meta.main) {
  runDaemonCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
