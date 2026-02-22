/**
 * Recursion guard for subworkflow invocations.
 *
 * Prevents:
 * - Direct recursion: A -> A
 * - Indirect recursion: A -> B -> A
 * - Excessive nesting: depth >= maxDepth
 */

export class SubworkflowRecursionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubworkflowRecursionError";
  }
}

export class SubworkflowDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubworkflowDepthError";
  }
}

export const DEFAULT_MAX_NESTING_DEPTH = 5;

/**
 * Assert that invoking `childAbsolutePath` does not cause recursion
 * and does not exceed the maximum nesting depth.
 *
 * @param childAbsolutePath Absolute path of the child workflow YAML.
 * @param callStack Array of absolute paths of parent workflow YAMLs (outermost first).
 * @param options.maxDepth Maximum allowed nesting depth.
 *
 * @throws {Error} if recursion or depth limit is detected.
 */
export function assertNoRecursion(
  childAbsolutePath: string,
  callStack: string[],
  options?: { maxDepth?: number },
): void {
  const maxDepth = options?.maxDepth ?? resolveMaxNestingDepth();

  // Depth check: the call stack already contains the current workflow,
  // adding the child would make it callStack.length + 1 deep.
  if (callStack.length >= maxDepth) {
    throw new SubworkflowDepthError(
      `Subworkflow nesting depth limit exceeded (max ${maxDepth}): ` +
        [...callStack, childAbsolutePath].join(" -> "),
    );
  }

  // Recursion check: child must not be in the call stack
  const idx = callStack.indexOf(childAbsolutePath);
  if (idx !== -1) {
    const cycle = [...callStack.slice(idx), childAbsolutePath];
    throw new SubworkflowRecursionError(
      `Recursive subworkflow call detected: ${cycle.join(" -> ")}`,
    );
  }
}

/**
 * Resolve the maximum nesting depth from:
 * 1. Explicit `configuredDepth` argument (highest priority).
 * 2. `ROBOPPI_MAX_SUBWORKFLOW_DEPTH` environment variable.
 * 3. Default of 5.
 */
export function resolveMaxNestingDepth(configuredDepth?: number): number {
  if (configuredDepth !== undefined && configuredDepth > 0) {
    return configuredDepth;
  }

  const envVal = process.env.ROBOPPI_MAX_SUBWORKFLOW_DEPTH;
  if (envVal !== undefined) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
  }

  return DEFAULT_MAX_NESTING_DEPTH;
}
