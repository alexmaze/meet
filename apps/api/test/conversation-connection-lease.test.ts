import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { maintainConversationConnection } from "../src/conversation-connection-lease.js";

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  ping = vi.fn();
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
}

function setup() {
  vi.useFakeTimers();
  const socket = new TestSocket();
  const heartbeat = vi.fn(
    async (_options: { active: boolean; activity: boolean }) => {},
  );
  const detach = vi.fn(async () => {});
  const lifecycle = maintainConversationConnection({
    socket: socket as unknown as WebSocket,
    attachedAt: Date.now(),
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 45_000,
    heartbeat,
    detach,
  });
  return { socket, heartbeat, detach, lifecycle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation connection lease", () => {
  it("expires a socket with no browser pong instead of renewing a ghost connection", async () => {
    const { socket, heartbeat, detach, lifecycle } = setup();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socket.ping).toHaveBeenCalledTimes(4);
    expect(heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lifecycle.isCurrent()).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(
      1008,
      "Conversation lease expired",
    );
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("marks established segments and renews only on a live peer response", async () => {
    const { socket, heartbeat, lifecycle } = setup();
    lifecycle.onReady();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    lifecycle.onActivity();
    socket.emit("pong");
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeat).toHaveBeenLastCalledWith({
      active: true,
      activity: true,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lifecycle.isCurrent()).toBe(true);
    socket.close();
  });

  it("closes immediately when authorization or the durable writer check fails", async () => {
    const { socket, heartbeat, detach, lifecycle } = setup();
    heartbeat.mockRejectedValueOnce(new Error("stale writer"));
    socket.emit("pong");
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.isCurrent()).toBe(false);
    expect(detach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
