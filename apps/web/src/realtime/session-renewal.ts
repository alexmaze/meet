import {
  realtimeRenewalServerFrameSchema,
  type RealtimeRenewalClientFrame,
} from "@meet/protocol";

type Task = { cancel(): void };

type RenewalDependencies = {
  now(): number;
  schedule(callback: () => void, delayMs: number): Task;
  isSafe(): boolean;
  send(frame: RealtimeRenewalClientFrame): void;
  flushRecords(): Promise<void>;
  renew(): void;
  notice(detail: string): void;
};

const QUIET_MS = 750;
const POLL_MS = 250;
const ACK_TIMEOUT_MS = 5_000;
const RETRY_MS = 2_000;

/** Coordinates a voluntary transport replacement, never a new business call.
 * The relay independently verifies its own quiet boundary. While preparing,
 * capture stays alive locally: new speech cancels the handshake before its
 * first packet is sent, rather than being lost behind a muted microphone.
 */
export class SessionRenewal {
  private due = false;
  private requestId: string | null = null;
  private flushing = false;
  private lastActivityAt = 0;
  private retryAfter = 0;
  private poll: Task | null = null;
  private timeout: Task | null = null;

  constructor(private readonly dependencies: RenewalDependencies) {}

  handleFrame(input: unknown): boolean {
    const parsed = realtimeRenewalServerFrameSchema.safeParse(input);
    if (!parsed.success) return false;
    const frame = parsed.data;
    if (frame.type === "relay.renewal_due") {
      if (!this.due) {
        this.due = true;
        this.lastActivityAt = this.dependencies.now();
        this.dependencies.notice("通话将自动续接，会等这一轮说完后继续。");
        this.schedule();
      }
    } else if (frame.event_id === this.requestId) {
      if (frame.type === "relay.renewal_deferred") {
        this.cancelPreparation(false);
      } else if (!this.flushing) {
        void this.finishPreparation(frame.event_id);
      }
    }
    return true;
  }

  activity(): void {
    this.lastActivityAt = this.dependencies.now();
    this.cancelPreparation(true);
  }

  /** The amplitude check is only a conservative veto, not turn detection. */
  allowMicrophonePacket(samples: Int16Array): boolean {
    if (samples.some((sample) => Math.abs(sample) >= 128)) this.activity();
    return this.requestId === null;
  }

  reset(): void {
    this.due = false;
    this.requestId = null;
    this.flushing = false;
    this.poll?.cancel();
    this.timeout?.cancel();
    this.poll = null;
    this.timeout = null;
    this.retryAfter = 0;
    this.lastActivityAt = this.dependencies.now();
  }

  private safe(): boolean {
    return (
      this.dependencies.isSafe() &&
      this.dependencies.now() - this.lastActivityAt >= QUIET_MS
    );
  }

  private schedule(): void {
    if (!this.due || this.poll || this.requestId) return;
    this.poll = this.dependencies.schedule(() => {
      this.poll = null;
      if (this.dependencies.now() >= this.retryAfter && this.safe()) {
        this.prepare();
      } else {
        this.schedule();
      }
    }, POLL_MS);
  }

  private prepare(): void {
    const eventId = `renewal_${crypto.randomUUID()}`;
    this.requestId = eventId;
    this.timeout = this.dependencies.schedule(() => {
      this.cancelPreparation(true);
    }, ACK_TIMEOUT_MS);
    try {
      this.dependencies.send({
        type: "relay.renewal_prepare",
        event_id: eventId,
      });
    } catch {
      this.cancelPreparation(false);
    }
  }

  private async finishPreparation(eventId: string): Promise<void> {
    if (!this.safe()) {
      this.cancelPreparation(true);
      return;
    }
    this.flushing = true;
    try {
      // Keep the old connection usable until all confirmed text is durable.
      await this.dependencies.flushRecords();
      if (this.requestId !== eventId) return;
      if (!this.safe()) {
        this.cancelPreparation(true);
        return;
      }
      this.reset();
      this.dependencies.renew();
    } catch {
      if (this.requestId !== eventId) return;
      this.cancelPreparation(true);
      this.dependencies.notice(
        "正在同步已确认记录，稍后自动续接；你可以继续聊天。",
      );
    }
  }

  private cancelPreparation(notifyRelay: boolean): void {
    const eventId = this.requestId;
    if (!eventId) return;
    this.requestId = null;
    this.flushing = false;
    this.timeout?.cancel();
    this.timeout = null;
    if (notifyRelay) {
      try {
        this.dependencies.send({
          type: "relay.renewal_cancel",
          event_id: eventId,
        });
      } catch {
        // Socket failure has its own bounded recovery path.
      }
    }
    this.retryAfter = this.dependencies.now() + RETRY_MS;
    this.schedule();
  }
}
