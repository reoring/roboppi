const DURATION_REGEX = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * Parse a DurationString like "5m", "30s", "2h", "1h30m" into milliseconds.
 * Supported units: h (hours), m (minutes), s (seconds).
 * At least one unit must be specified.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error(`Invalid duration string: "${input}"`);
  }

  const match = DURATION_REGEX.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid duration string: "${input}"`);
  }

  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const seconds = match[3] ? parseInt(match[3], 10) : 0;

  if (hours === 0 && minutes === 0 && seconds === 0) {
    throw new Error(`Invalid duration string: "${input}"`);
  }

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}
