/**
 * Environment variable compatibility layer.
 *
 * Roboppi is the product name, but this repo historically used the `AGENTCORE_`
 * prefix for many environment variables.
 *
 * To keep backward compatibility while moving docs/examples to `ROBOPPI_`, we
 * mirror values across prefixes (without overriding explicitly-set values).
 */

export function applyEnvPrefixAliases(): void {
  const env = process.env as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    if (key.startsWith("ROBOPPI_")) {
      const suffix = key.slice("ROBOPPI_".length);
      const legacy = `AGENTCORE_${suffix}`;
      if (env[legacy] === undefined) env[legacy] = value;
      continue;
    }

    if (key.startsWith("AGENTCORE_")) {
      const suffix = key.slice("AGENTCORE_".length);
      const modern = `ROBOPPI_${suffix}`;
      if (env[modern] === undefined) env[modern] = value;
      continue;
    }
  }
}
