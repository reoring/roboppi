/**
 * LeadInboxBroker — runner-owned component that continuously consumes the
 * lead's mailbox and maintains a bounded, secret-safe summary artifact.
 *
 * See `docs/features/agents-resident-lead-dynamic-members.md` §3.1.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { recvMessages, ackMessageByClaimToken } from "./store.js";
import { inboxSummaryPath } from "./paths.js";
import { atomicJsonWrite } from "./fs-atomic.js";
import { agentsRoot } from "./paths.js";
import { resolve } from "node:path";
import {
  DEFAULT_BROKER_POLL_INTERVAL_MS,
  DEFAULT_BROKER_MAX_SUMMARY_ENTRIES,
  DEFAULT_BROKER_PREVIEW_MAX_BYTES,
  DEFAULT_BROKER_BATCH_SIZE,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Inbox summary schema
// ---------------------------------------------------------------------------

export interface InboxSummaryEntry {
  message_id: string;
  ts: number;
  from: string;
  topic: string;
  kind: string;
  body_preview?: string;
  /** Context-relative path to the acked message file under _agents/. */
  mailbox_path: string;
}

export interface InboxSummary {
  version: "1";
  team_id: string;
  lead_member_id: string;
  updated_at: number;
  unread_count: number;
  entries: InboxSummaryEntry[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LeadInboxBrokerOptions {
  contextDir: string;
  teamId: string;
  leadMemberId: string;
  pollIntervalMs?: number;
  maxSummaryEntries?: number;
  previewMaxBytes?: number;
  batchSize?: number;
  /** Optional AbortSignal for prompt stop when workflow is cancelled. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// LeadInboxBroker
// ---------------------------------------------------------------------------

export class LeadInboxBroker {
  private readonly contextDir: string;
  private readonly teamId: string;
  private readonly leadMemberId: string;
  private readonly pollIntervalMs: number;
  private readonly maxSummaryEntries: number;
  private readonly previewMaxBytes: number;
  private readonly batchSize: number;
  private readonly signal?: AbortSignal;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private abortHandler: (() => void) | null = null;

  /** In-memory summary entries — written to disk after each poll cycle. */
  private entries: InboxSummaryEntry[] = [];
  private totalProcessed = 0;

  constructor(opts: LeadInboxBrokerOptions) {
    this.contextDir = opts.contextDir;
    this.teamId = opts.teamId;
    this.leadMemberId = opts.leadMemberId;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_BROKER_POLL_INTERVAL_MS;
    this.maxSummaryEntries = opts.maxSummaryEntries ?? DEFAULT_BROKER_MAX_SUMMARY_ENTRIES;
    this.previewMaxBytes = opts.previewMaxBytes ?? DEFAULT_BROKER_PREVIEW_MAX_BYTES;
    this.batchSize = opts.batchSize ?? DEFAULT_BROKER_BATCH_SIZE;
    this.signal = opts.signal;
  }

  /**
   * Start the broker loop.  Returns immediately; the loop runs asynchronously.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    // Wire up AbortSignal for prompt stop
    if (this.signal) {
      if (this.signal.aborted) {
        this.stop();
        return;
      }
      this.abortHandler = () => this.stop();
      this.signal.addEventListener("abort", this.abortHandler, { once: true });
    }

    this.scheduleNext(0); // first poll immediately
  }

  /**
   * Stop the broker.  Clears all timers, abort listener, and prevents further polls.
   */
  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Remove abort listener to prevent leaks
    if (this.abortHandler && this.signal) {
      this.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.poll().catch(() => {}).finally(() => {
        if (!this.stopped) {
          this.scheduleNext(this.pollIntervalMs);
        }
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    // Claim messages from the lead inbox
    const messages = await recvMessages({
      contextDir: this.contextDir,
      memberId: this.leadMemberId,
      claim: true,
      max: this.batchSize,
    });

    if (messages.length === 0) return;

    for (const msg of messages) {
      if (this.stopped) return;

      // Build summary entry (secret-safe: no full body)
      const entry: InboxSummaryEntry = {
        message_id: msg.messageId,
        ts: msg.message.ts,
        from: msg.message.from.member_id,
        topic: msg.message.topic,
        kind: msg.message.kind,
        mailbox_path: `_agents/mailbox/inbox/${this.leadMemberId}/cur/${msg.filename}`,
      };

      // Secret-safe truncated body preview — only include when actual
      // truncation occurs (body longer than previewMaxBytes).  Short bodies
      // are omitted entirely so the summary never contains a full message body.
      if (msg.message.body) {
        const bodyBuf = Buffer.from(msg.message.body, "utf-8");
        if (bodyBuf.length > this.previewMaxBytes) {
          entry.body_preview =
            bodyBuf.subarray(0, this.previewMaxBytes).toString("utf-8") + "...";
        }
      }

      this.entries.push(entry);
      this.totalProcessed++;

      // Ack the message (moves from processing/ to cur/)
      if (msg.claim?.token) {
        await ackMessageByClaimToken(
          this.contextDir,
          this.leadMemberId,
          msg.claim.token,
        );
      }
    }

    // Bound the summary to maxSummaryEntries (keep most recent)
    if (this.entries.length > this.maxSummaryEntries) {
      this.entries = this.entries.slice(-this.maxSummaryEntries);
    }

    // Write/update the inbox summary artifact
    await this.writeSummary();
  }

  private async writeSummary(): Promise<void> {
    const summaryPath = inboxSummaryPath(this.contextDir);
    await mkdir(dirname(summaryPath), { recursive: true });

    const summary: InboxSummary = {
      version: "1",
      team_id: this.teamId,
      lead_member_id: this.leadMemberId,
      updated_at: Date.now(),
      unread_count: this.totalProcessed,
      entries: this.entries,
    };

    const tmpDir = resolve(agentsRoot(this.contextDir), "tmp");
    await atomicJsonWrite(tmpDir, summaryPath, summary);
  }
}
