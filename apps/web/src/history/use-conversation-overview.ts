import type { ConversationOverviewResponse } from "@meet/protocol";
import { useEffect, useState } from "react";
import { ConversationApiError } from "./conversation-api.js";
import {
  clearPendingEndOperation,
  getStatus,
  listOverview,
  listPendingEndOperations,
} from "./continuity-api.js";
import { applyPendingEndOperation } from "./continuity-presentation.js";

export function useConversationOverview({
  userId,
  characterId,
  reload = 0,
  enabled = true,
  onUnauthorized,
}: {
  userId: string;
  characterId?: string;
  reload?: number;
  enabled?: boolean;
  onUnauthorized: () => void;
}) {
  const [overview, setOverview] = useState<ConversationOverviewResponse>({
    pending: [],
    pendingCount: 0,
    recent: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const load = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        const result = await listOverview(characterId, controller.signal);
        const operations = listPendingEndOperations(userId);
        const checked = await Promise.all(
          operations.map(async (operation) => {
            try {
              const status = await getStatus(
                operation.conversationId,
                operation.requestId,
                controller.signal,
              );
              if (status.connectionState === "completed") {
                clearPendingEndOperation(operation.conversationId, userId);
                return status;
              }
              return applyPendingEndOperation(status, operation);
            } catch (cause) {
              if (
                cause instanceof ConversationApiError &&
                cause.status === 404
              ) {
                clearPendingEndOperation(operation.conversationId, userId);
                return null;
              }
              throw cause;
            }
          }),
        );
        if (controller.signal.aborted) return;
        const byId = new Map(
          checked
            .filter((status) => status !== null)
            .map((status) => [status.conversation.id, status]),
        );
        const pending = result.pending
          .map((status) => byId.get(status.conversation.id) ?? status)
          .filter((status) => status.connectionState !== "completed");
        setOverview({ ...result, pending, pendingCount: pending.length });
        setError("");
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ConversationApiError && cause.status === 401) {
          onUnauthorized();
          return;
        }
        setError("暂时无法确认通话记录，可以继续选择角色聊天。");
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => {
            if (document.visibilityState === "visible") void load();
          }, 15_000);
        }
      }
    };
    setLoading(true);
    void load();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, characterId, reload, enabled, onUnauthorized]);
  return { overview, loading, error };
}
