import { GitHubIssueSource } from "./github-issue-source.js";
import { GitHubPullRequestSource } from "./github-pull-request-source.js";
import { FileInboxSource } from "./file-inbox-source.js";
import type {
  TaskOrchestratorConfig,
  TaskSource,
  TaskSourceConfig,
} from "./types.js";

export interface TaskSourceBinding {
  id: string;
  source: TaskSource;
  config: TaskSourceConfig;
}

export function createTaskSources(
  config: TaskOrchestratorConfig,
  baseDir: string = process.cwd(),
): TaskSourceBinding[] {
  return Object.entries(config.sources).map(([sourceId, sourceConfig]) => ({
    id: sourceId,
    config: sourceConfig,
    source: createTaskSource(sourceId, sourceConfig, baseDir),
  }));
}

export function createTaskSource(
  sourceId: string,
  config: TaskSourceConfig,
  baseDir: string = process.cwd(),
): TaskSource {
  switch (config.type) {
    case "file_inbox":
      return new FileInboxSource(sourceId, config, baseDir);
    case "github_issue":
      return new GitHubIssueSource(sourceId, config);
    case "github_pull_request":
      return new GitHubPullRequestSource(sourceId, config);
  }
}
