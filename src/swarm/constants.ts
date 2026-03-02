/**
 * Swarm constants.
 *
 * See `docs/features/swarm.md` for rationale.
 */

/** Maximum message body size in bytes (64 KB). */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Maximum task file size in bytes (256 KB). */
export const MAX_TASK_BYTES = 256 * 1024;

/** Default processing TTL in ms (10 minutes). */
export const DEFAULT_PROCESSING_TTL_MS = 10 * 60 * 1000;

/** Maximum delivery attempts before moving to dead/. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Default polling interval for recv --wait-ms (1 second). */
export const DEFAULT_RECV_POLL_INTERVAL_MS = 1000;
