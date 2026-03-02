/**
 * Swarm on-disk layout path helpers.
 *
 * All paths are rooted at `<context_dir>/_swarm/`.  Every public function
 * rejects any attempt to escape the swarm root via path traversal.
 */
import { resolve, relative } from "node:path";

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

export class PathTraversalError extends Error {
  constructor(detail: string) {
    super(`Path traversal rejected: ${detail}`);
    this.name = "PathTraversalError";
  }
}

/**
 * Return `resolved` only if it stays within `root`.  Throws otherwise.
 */
function assertWithin(root: string, resolved: string): string {
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || resolve(root, rel) !== resolved) {
    throw new PathTraversalError(`"${resolved}" escapes "${root}"`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Layout accessors
// ---------------------------------------------------------------------------

export function swarmRoot(contextDir: string): string {
  return resolve(contextDir, "_swarm");
}

export function teamJsonPath(contextDir: string): string {
  return resolve(swarmRoot(contextDir), "team.json");
}

export function membersJsonPath(contextDir: string): string {
  return resolve(swarmRoot(contextDir), "members.json");
}

// -- Mailbox ---------------------------------------------------------------

export function mailboxRoot(contextDir: string): string {
  return resolve(swarmRoot(contextDir), "mailbox");
}

export function mailboxTmp(contextDir: string): string {
  return resolve(mailboxRoot(contextDir), "tmp");
}

export function inboxDir(contextDir: string, memberId: string): string {
  const p = resolve(mailboxRoot(contextDir), "inbox", memberId);
  return assertWithin(swarmRoot(contextDir), p);
}

export function inboxNew(contextDir: string, memberId: string): string {
  return resolve(inboxDir(contextDir, memberId), "new");
}

export function inboxProcessing(contextDir: string, memberId: string): string {
  return resolve(inboxDir(contextDir, memberId), "processing");
}

export function inboxCur(contextDir: string, memberId: string): string {
  return resolve(inboxDir(contextDir, memberId), "cur");
}

export function inboxDead(contextDir: string, memberId: string): string {
  return resolve(inboxDir(contextDir, memberId), "dead");
}

export function sentDir(contextDir: string, memberId: string): string {
  const p = resolve(mailboxRoot(contextDir), "sent", memberId);
  return assertWithin(swarmRoot(contextDir), p);
}

export function mailboxEventsPath(contextDir: string): string {
  return resolve(mailboxRoot(contextDir), "_events.jsonl");
}

// -- Tasks -----------------------------------------------------------------

export function tasksRoot(contextDir: string): string {
  return resolve(swarmRoot(contextDir), "tasks");
}

export function tasksTmp(contextDir: string): string {
  return resolve(tasksRoot(contextDir), "tmp");
}

export function tasksStatusDir(contextDir: string, status: string): string {
  const p = resolve(tasksRoot(contextDir), status);
  return assertWithin(swarmRoot(contextDir), p);
}

export function tasksEventsPath(contextDir: string): string {
  return resolve(tasksRoot(contextDir), "_events.jsonl");
}

// -- Locks -----------------------------------------------------------------

export function locksDir(contextDir: string): string {
  return resolve(swarmRoot(contextDir), "locks");
}

// ---------------------------------------------------------------------------
// All directories that initSwarmContext must create
// ---------------------------------------------------------------------------

export function allDirs(contextDir: string, memberIds: string[]): string[] {
  const dirs: string[] = [
    swarmRoot(contextDir),
    mailboxRoot(contextDir),
    mailboxTmp(contextDir),
    tasksRoot(contextDir),
    tasksTmp(contextDir),
    tasksStatusDir(contextDir, "pending"),
    tasksStatusDir(contextDir, "in_progress"),
    tasksStatusDir(contextDir, "completed"),
    tasksStatusDir(contextDir, "blocked"),
    locksDir(contextDir),
  ];
  for (const id of memberIds) {
    dirs.push(inboxDir(contextDir, id));
    dirs.push(inboxNew(contextDir, id));
    dirs.push(inboxProcessing(contextDir, id));
    dirs.push(inboxCur(contextDir, id));
    dirs.push(inboxDead(contextDir, id));
    dirs.push(sentDir(contextDir, id));
  }
  return dirs;
}
