import type { WorkflowUiState } from "../state-store.js";
import { isAgentStep, agentMemberId } from "../state-store.js";
import { renderOverviewTab } from "./tabs/overview-tab.js";
import { renderLogsTab } from "./tabs/logs-tab.js";
import { renderRawLogsTab } from "./tabs/raw-logs-tab.js";
import { renderUsageTab } from "./tabs/usage-tab.js";
import { renderDiffsTab } from "./tabs/diffs-tab.js";
import { renderResultTab } from "./tabs/result-tab.js";
import { renderCoreTab } from "./tabs/core-tab.js";
import { renderHelpTab } from "./tabs/help-tab.js";
import { renderAgentsTab } from "./tabs/agents-tab.js";
import { renderChatTab } from "./tabs/chat-tab.js";
import { renderAgentOverviewTab } from "./tabs/agent-overview-tab.js";
import { ansiFit } from "../ansi-utils.js";

const STEP_TABS = [
  { key: "1", id: "overview", label: "Overview" },
  { key: "2", id: "logs", label: "Timeline" },
  { key: "3", id: "raw_logs", label: "Raw" },
  { key: "4", id: "diffs", label: "Diffs" },
  { key: "5", id: "usage", label: "Usage" },
  { key: "6", id: "result", label: "Result" },
  { key: "7", id: "core", label: "Core" },
  { key: "8", id: "agents", label: "Agents" },
  { key: "9", id: "chat", label: "Chat" },
  { key: "0", id: "help", label: "Help" },
] as const;

const AGENT_TABS = [
  { key: "1", id: "chat", label: "Chat" },
  { key: "2", id: "agent_overview", label: "Agent" },
  { key: "3", id: "logs", label: "Timeline" },
  { key: "4", id: "raw_logs", label: "Raw" },
  { key: "5", id: "usage", label: "Usage" },
  { key: "6", id: "agents", label: "Activity" },
  { key: "7", id: "result", label: "Result" },
  { key: "8", id: "core", label: "Core" },
  { key: "9", id: "help", label: "Help" },
] as const;

/**
 * When the user switches between a step and an agent entry, map
 * the current tab to its equivalent in the other context.
 */
export function resolveEffectiveTab(
  currentTab: WorkflowUiState["selectedTab"],
  selectedStepId: string,
): WorkflowUiState["selectedTab"] {
  const isAgent = isAgentStep(selectedStepId);

  if (isAgent) {
    // Moving to agent context — Chat is the default tab for agents
    switch (currentTab) {
      case "overview": return "agent_overview";
      case "diffs": return "agents";
      default: return currentTab;
    }
  } else {
    // Moving to step context
    switch (currentTab) {
      case "agent_overview": return "overview";
      default: return currentTab;
    }
  }
}

export function renderDetailPane(state: WorkflowUiState, width: number, height: number): string {
  const isAgent = state.selectedStepId ? isAgentStep(state.selectedStepId) : false;
  const tabs = isAgent ? AGENT_TABS : STEP_TABS;

  // Tab bar
  const tabBarRaw = tabs.map((t) => {
    const active = state.selectedTab === t.id;
    if (active) {
      return `\x1b[1m\x1b[4m${t.key}:${t.label}\x1b[0m`;
    }
    return `\x1b[90m${t.key}:${t.label}\x1b[0m`;
  }).join("  ");

  const w = Math.max(0, width);
  const tabBar = ansiFit(tabBarRaw, w);

  const contentHeight = height - 2; // tab bar + separator
  const step = state.selectedStepId ? state.steps.get(state.selectedStepId) : undefined;
  const memberId = state.selectedStepId ? agentMemberId(state.selectedStepId) : undefined;
  const rosterEntry = memberId ? state.agentRoster.get(memberId) : undefined;

  let content: string;
  switch (state.selectedTab) {
    case "overview":
      content = renderOverviewTab(state, step, width, contentHeight);
      break;
    case "agent_overview":
      content = renderAgentOverviewTab(state, step, rosterEntry, memberId ?? "", width, contentHeight);
      break;
    case "logs":
      content = renderLogsTab(step, width, contentHeight);
      break;
    case "raw_logs":
      content = renderRawLogsTab(step, width, contentHeight);
      break;
    case "usage":
      content = renderUsageTab(state, step, memberId, width, contentHeight);
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
    case "agents":
      content = renderAgentsTab(state, width, contentHeight, memberId);
      break;
    case "chat":
      content = renderChatTab(state, width, contentHeight);
      break;
    case "help":
      content = renderHelpTab(width, contentHeight);
      break;
    default:
      content = "";
  }

  return tabBar + "\n\x1b[90m" + "\u2500".repeat(w) + "\x1b[0m\n" + content;
}
