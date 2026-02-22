import type { WorkflowUiState } from "../state-store.js";
import { renderOverviewTab } from "./tabs/overview-tab.js";
import { renderLogsTab } from "./tabs/logs-tab.js";
import { renderDiffsTab } from "./tabs/diffs-tab.js";
import { renderResultTab } from "./tabs/result-tab.js";
import { renderCoreTab } from "./tabs/core-tab.js";
import { renderHelpTab } from "./tabs/help-tab.js";

const TABS = [
  { key: "1", id: "overview", label: "Overview" },
  { key: "2", id: "logs", label: "Logs" },
  { key: "3", id: "diffs", label: "Diffs" },
  { key: "4", id: "result", label: "Result" },
  { key: "5", id: "core", label: "Core" },
  { key: "6", id: "help", label: "Help" },
] as const;

export function renderDetailPane(state: WorkflowUiState, width: number, height: number): string {
  // Tab bar
  const tabBar = TABS.map((t) => {
    const active = state.selectedTab === t.id;
    if (active) {
      return `\x1b[1m\x1b[4m${t.key}:${t.label}\x1b[0m`;
    }
    return `\x1b[90m${t.key}:${t.label}\x1b[0m`;
  }).join("  ");

  const contentHeight = height - 2; // tab bar + separator
  const step = state.selectedStepId ? state.steps.get(state.selectedStepId) : undefined;

  let content: string;
  switch (state.selectedTab) {
    case "overview":
      content = renderOverviewTab(state, step, width, contentHeight);
      break;
    case "logs":
      content = renderLogsTab(step, width, contentHeight);
      break;
    case "diffs":
      content = renderDiffsTab(step, width, contentHeight);
      break;
    case "result":
      content = renderResultTab(step, width, contentHeight);
      break;
    case "core":
      content = renderCoreTab(state, width, contentHeight);
      break;
    case "help":
      content = renderHelpTab(width, contentHeight);
      break;
    default:
      content = "";
  }

  return tabBar + "\n\x1b[90m" + "\u2500".repeat(width) + "\x1b[0m\n" + content;
}
