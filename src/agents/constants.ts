/**
 * Agent constants.
 *
 * See `docs/features/agents.md` for rationale.
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

/** Default claim token TTL in ms (10 minutes, matches processing TTL). */
export const DEFAULT_CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Default poll interval for LeadInboxBroker (2 seconds). */
export const DEFAULT_BROKER_POLL_INTERVAL_MS = 2_000;

/** Maximum entries kept in inbox-summary.json. */
export const DEFAULT_BROKER_MAX_SUMMARY_ENTRIES = 100;

/** Maximum bytes for body_preview in inbox summary entries. */
export const DEFAULT_BROKER_PREVIEW_MAX_BYTES = 200;

/** Maximum messages to claim per broker poll cycle. */
export const DEFAULT_BROKER_BATCH_SIZE = 10;

/** Default reconcile loop interval (2 seconds). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;

/** Default maximum teammates cap for dynamic membership. */
export const DEFAULT_MAX_TEAMMATES = 10;

/** Default maximum teammate spawns per minute for rate limiting. */
export const DEFAULT_MAX_SPAWNS_PER_MINUTE = 5;

/** Default polling interval for `agents chat` receive loop (1 second). */
export const DEFAULT_CHAT_POLL_INTERVAL_MS = 1_000;

/** Default polling interval for ResidentAgent inbox/task check (3 seconds). */
export const DEFAULT_RESIDENT_POLL_INTERVAL_MS = 3_000;

/** Default per-dispatch timeout for ResidentAgent CLI agent invocations (30 minutes). */
export const DEFAULT_RESIDENT_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

/** Maximum session history entries kept by ResidentAgent. */
export const DEFAULT_RESIDENT_MAX_HISTORY = 50;
