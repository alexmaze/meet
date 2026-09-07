import type { ConversationContinuityStatus } from "@meet/protocol";

export function applyPendingEndOperation(
  status: ConversationContinuityStatus,
  operation: {
    conversationId: string;
    requestId: string;
    lastSequence: number;
  } | null,
): ConversationContinuityStatus {
  if (
    !operation ||
    !status.isOwner ||
    status.connectionState === "completed" ||
    operation.conversationId !== status.conversation.id
  )
    return status;
  return {
    ...status,
    endRequestId: operation.requestId,
    endTargetSequence: operation.lastSequence,
  };
}

export function conversationStateLabel(
  status: ConversationContinuityStatus,
): string {
  if (status.connectionState === "completed") return "已结束";
  if (status.endRequestId) return "等待结束确认";
  if (status.connectionState === "connected") return "正在通话";
  if (status.connectionState !== "interrupted") return "正在确认通话状态";
  return status.canResume ? "已中断，可恢复" : "已中断";
}

export function conversationActions(
  status: ConversationContinuityStatus,
  readOnly = false,
): {
  resume: string | null;
  start: string | null;
  finish: boolean;
  remove: boolean;
} {
  if (readOnly || !status.isOwner)
    return { resume: null, start: null, finish: false, remove: false };
  const temporary = status.conversation.mode === "temporary";
  const completed = status.connectionState === "completed";
  return {
    resume:
      !completed && !status.endRequestId && status.canResume
        ? temporary
          ? "恢复临时对话"
          : "恢复通话"
        : null,
    start: completed ? (temporary ? "新的临时对话" : "再次聊天") : null,
    finish: !completed && status.canFinish,
    remove: completed,
  };
}

export function analysisStateLabel(
  state: ConversationContinuityStatus["summary"]["state"],
  kind: "summary" | "memory",
): string {
  const noun = kind === "summary" ? "回顾" : "长期记忆";
  switch (state) {
    case "completed":
      return "已整理";
    case "not_configured":
      return `暂未启用${noun}整理，文字已保存`;
    case "failed":
      return `${noun}暂未整理完成，文字已保存`;
    case "not_applicable":
      return kind === "memory"
        ? "临时对话不新增长期记忆"
        : "本次没有需要整理的内容";
    case "not_started":
      return "等待整理，可以稍后查看";
    case "processing":
      return "正在整理，可以稍后查看";
  }
}

export function formatConversationDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    year:
      new Date(value).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  }).format(new Date(value));
}

export function formatConnectedDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
