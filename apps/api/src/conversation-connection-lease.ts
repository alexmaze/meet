import { WebSocket } from "ws";

export type RelayConnectionLifecycle = {
  isCurrent: () => boolean;
  onReady: () => void;
  onActivity: () => void;
};

/** A local deadline fences audio too: a stalled process must not forward old
 * frames while waiting for its next database heartbeat to discover expiry. */
export function maintainConversationConnection(input: {
  socket: WebSocket;
  attachedAt: number;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  heartbeat: (options: { active: boolean; activity: boolean }) => Promise<void>;
  detach: () => Promise<void>;
}): RelayConnectionLifecycle {
  let expiresAt = input.attachedAt + input.leaseDurationMs;
  let closed = false;
  let active = false;
  let activity = false;
  let renewing = false;

  const release = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    void input.detach().catch(() => {
      // A failed release is bounded by the durable lease expiry.
    });
  };
  const stop = () => {
    if (input.socket.readyState === WebSocket.OPEN) {
      input.socket.send(
        JSON.stringify({
          type: "relay.error",
          code: "CONVERSATION_WRITER_STALE",
          message: "通话连接已失效，请重新确认后继续。",
        }),
      );
    }
    input.socket.close(1008, "Conversation lease expired");
    release();
  };
  const isCurrent = () => {
    if (closed) return false;
    if (Date.now() >= expiresAt) {
      stop();
      return false;
    }
    return true;
  };
  const renew = async () => {
    if (!isCurrent() || renewing) return;
    renewing = true;
    const requestedAt = Date.now();
    const observedActivity = activity;
    activity = false;
    try {
      await input.heartbeat({ active, activity: observedActivity });
      if (!closed) expiresAt = requestedAt + input.leaseDurationMs;
    } catch {
      if (!closed) stop();
    } finally {
      renewing = false;
    }
  };
  // Only a browser pong can renew a live lease. An open server socket alone
  // does not prove that a suspended/offline device is still connected.
  const timer = setInterval(() => {
    if (isCurrent() && input.socket.readyState === WebSocket.OPEN)
      input.socket.ping();
  }, input.heartbeatIntervalMs);
  timer.unref();
  input.socket.on("pong", () => void renew());
  input.socket.once("close", release);
  input.socket.once("error", release);
  return {
    isCurrent,
    onReady() {
      active = true;
      void renew();
    },
    onActivity() {
      activity = true;
    },
  };
}
