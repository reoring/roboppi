/**
 * Parse a DurationString like "5m", "30s", "2h", "1h30m" into milliseconds.
 * Supported units: h (hours), m (minutes), s (seconds), ms (milliseconds).
 * At least one unit must be specified.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error(`Invalid duration string: "${input}"`);
  }

  // Tokenize the string as repeated "<number><unit>" segments.
  // Example: "1h30m10s500ms"
  const tokenRe = /(\d+)(ms|s|m|h)/g;
  let totalMs = 0;
  let matchedLen = 0;

  for (const match of trimmed.matchAll(tokenRe)) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    matchedLen += match[0]!.length;

    switch (unit) {
      case "h":
        totalMs += value * 3600_000;
        break;
      case "m":
        totalMs += value * 60_000;
        break;
      case "s":
        totalMs += value * 1000;
        break;
      case "ms":
        totalMs += value;
        break;
    }
  }

  if (matchedLen !== trimmed.length) {
    throw new Error(`Invalid duration string: "${input}"`);
  }

  if (totalMs <= 0) {
    throw new Error(`Invalid duration string: "${input}"`);
  }

  return totalMs;
}
