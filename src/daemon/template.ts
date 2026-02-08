/**
 * Template variable expansion.
 * Replaces {{var_name}} with values from the given vars map.
 *
 * Supports dot notation for nested JSON access:
 *   {{event.type}} — parse vars["event"] as JSON, then access .type
 *   {{last_result.status}} — parse vars["last_result"] as JSON, access .status
 *
 * Resolution order:
 *   1. Exact key match (vars[full_key])
 *   2. Dot traversal (parse root as JSON, traverse path)
 *   3. Leave as-is if unresolved
 */
export function expandTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  // Use a sentinel to prevent re-expansion: replace expanded values with
  // placeholders first, then swap them back in a second pass.
  const replacements: string[] = [];

  const withSentinels = template.replace(/\{\{([\w.]+)\}\}/g, (_match, key: string) => {
    // 1. Exact key match
    if (key in vars) {
      const idx = replacements.length;
      replacements.push(vars[key]!);
      return `\x00EXPANDED_${idx}\x00`;
    }

    // 2. Dot notation: try nested JSON traversal
    const dotIndex = key.indexOf(".");
    if (dotIndex !== -1) {
      const rootKey = key.substring(0, dotIndex);
      const jsonPath = key.substring(dotIndex + 1);
      const rootValue = vars[rootKey];
      if (rootValue !== undefined) {
        const resolved = resolveJsonPath(rootValue, jsonPath);
        if (resolved !== undefined) {
          const idx = replacements.length;
          replacements.push(typeof resolved === "string" ? resolved : JSON.stringify(resolved));
          return `\x00EXPANDED_${idx}\x00`;
        }
      }
    }

    // 3. Unresolved — leave as-is
    return `{{${key}}}`;
  });

  // Second pass: replace sentinels with actual values (no further template processing)
  return withSentinels.replace(/\x00EXPANDED_(\d+)\x00/g, (_match, idxStr: string) => {
    return replacements[parseInt(idxStr, 10)]!;
  });
}

/**
 * Parse a JSON string and traverse a dot-separated path.
 * Returns undefined if parsing fails or path doesn't exist.
 */
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function resolveJsonPath(jsonStr: string, path: string): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return undefined;
  }

  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    if (DANGEROUS_KEYS.has(part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
