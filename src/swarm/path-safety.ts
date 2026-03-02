/**
 * Swarm path safety — symlink escape prevention.
 *
 * Spec 3.5: all filesystem mutations for swarm data MUST remain inside
 * `<context_dir>/_swarm`.  User-supplied path values MUST reject absolute
 * paths (unless explicitly allowed), `..` traversal, and symlink escape.
 */
import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { swarmRoot } from "./paths.js";

export class SwarmPathSafetyError extends Error {
  constructor(detail: string) {
    super(`Swarm path safety violation: ${detail}`);
    this.name = "SwarmPathSafetyError";
  }
}

/**
 * Assert that the swarm root itself is not a symlink escaping outside the
 * context dir.  Call this once before any swarm mutation.
 */
export async function assertSwarmRootSafe(contextDir: string): Promise<void> {
  const root = swarmRoot(contextDir);
  let real: string;
  try {
    real = await realpath(root);
  } catch {
    // Directory doesn't exist yet (will be created); that's fine.
    return;
  }
  const resolvedContextDir = resolve(contextDir);
  const rel = relative(resolvedContextDir, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SwarmPathSafetyError(
      `_swarm root resolves to "${real}" which is outside context dir "${resolvedContextDir}"`,
    );
  }
}

/**
 * Validate a user-supplied member ID for path safety.
 * Member IDs are used to construct inbox paths; they must not contain
 * traversal sequences or path separators.
 */
export function validateMemberIdPath(memberId: string): void {
  if (!memberId) {
    throw new SwarmPathSafetyError("member ID must not be empty");
  }
  if (memberId.includes("/") || memberId.includes("\\")) {
    throw new SwarmPathSafetyError(`member ID must not contain path separators: "${memberId}"`);
  }
  if (memberId === "." || memberId === ".." || memberId.includes("..")) {
    throw new SwarmPathSafetyError(`member ID must not contain traversal sequences: "${memberId}"`);
  }
}

/**
 * Validate a user-supplied task/message ID for path safety.
 */
export function validateIdPath(id: string, label: string): void {
  if (!id) {
    throw new SwarmPathSafetyError(`${label} must not be empty`);
  }
  if (id.includes("/") || id.includes("\\")) {
    throw new SwarmPathSafetyError(`${label} must not contain path separators: "${id}"`);
  }
  if (id === "." || id === ".." || id.includes("..")) {
    throw new SwarmPathSafetyError(`${label} must not contain traversal sequences: "${id}"`);
  }
}
