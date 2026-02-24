export function renderHelpTab(_width: number, height: number): string {
  const lines = [
    "\x1b[1mKeyboard Shortcuts\x1b[0m",
    "",
    "  \x1b[1mj/k\x1b[0m or \x1b[1m\u2191/\u2193\x1b[0m     Navigate steps",
    "  \x1b[1mEnter\x1b[0m            Lock step selection",
    "  \x1b[1mf\x1b[0m                Follow running step",
    "  \x1b[1mSpace\x1b[0m            Toggle follow mode",
    "  \x1b[1my\x1b[0m                Copy visible tab",
    "  \x1b[1m1-6\x1b[0m              Switch tabs",
    "  \x1b[1mCtrl+C\x1b[0m           Cancel workflow",
    "  \x1b[1mq\x1b[0m                Quit",
    "",
    "\x1b[1mStatus Legend\x1b[0m",
    "",
    "  \x1b[90m\u25CB\x1b[0m PENDING      Step waiting for dependencies",
    "  \x1b[36m\u25CE\x1b[0m READY        Dependencies resolved, queued",
    "  \x1b[33m\u25CF\x1b[0m RUNNING      Worker executing",
    "  \x1b[35m\u25C9\x1b[0m CHECKING     Completion check running",
    "  \x1b[32m\u2713\x1b[0m SUCCEEDED    Step completed successfully",
    "  \x1b[31m\u2717\x1b[0m FAILED       Step failed",
    "  \x1b[90m\u25D1\x1b[0m INCOMPLETE   Max iterations reached",
    "  \x1b[90m\u2298\x1b[0m SKIPPED      Dependency failed",
    "  \x1b[31m\u2298\x1b[0m CANCELLED    Workflow cancelled",
    "",
    "\x1b[1mTabs\x1b[0m",
    "",
    "  1: Overview    Step summary + workflow counts",
    "  2: Logs        stdout/stderr/progress streams",
    "  3: Diffs       File patches and diffs",
    "  4: Result      Final WorkerResult details",
    "  5: Core        Core stderr logs (supervised)",
    "  6: Help        This help screen",
  ];

  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
