import type {
  ConversationContinuityStatus,
  ConversationMessage,
  ConversationMode,
  ConversationSummary,
} from "@meet/protocol";
import { useEffect, useState, type CSSProperties } from "react";

import {
  ConversationApiError,
  deleteConversation,
  getConversation,
  listConversations,
} from "./conversation-api.js";
import {
  clearPendingEndOperation,
  getPendingEndOperation,
  getStatus,
  listOverview,
} from "./continuity-api.js";
import {
  applyPendingEndOperation,
  conversationActions,
  conversationStateLabel,
  formatConnectedDuration,
  formatConversationDate,
} from "./continuity-presentation.js";
import ConversationReview, {
  type MemoryLocation,
} from "./ConversationReview.js";

type HistoryPageProps = {
  currentUserId: string;
  initialConversationId?: string;
  readOnly?: boolean;
  onCall: (characterId: string, mode: ConversationMode) => void;
  onResume: (status: ConversationContinuityStatus) => void;
  onFinish: (status: ConversationContinuityStatus) => Promise<void>;
  onViewMemories?: (location: MemoryLocation) => void;
  onUnauthorized: () => void;
};
type Detail = {
  status: ConversationContinuityStatus;
  messages: ConversationMessage[];
};

export default function HistoryPage({
  currentUserId,
  initialConversationId,
  readOnly = false,
  onCall,
  onResume,
  onFinish,
  onViewMemories,
  onUnauthorized,
}: HistoryPageProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [states, setStates] = useState<
    Map<string, ConversationContinuityStatus>
  >(new Map());
  const [selectedId, setSelectedId] = useState(initialConversationId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const load = async () => {
      try {
        if (selectedId) {
          const [record, status] = await Promise.all([
            getConversation(selectedId, controller.signal),
            getStatus(
              selectedId,
              getPendingEndOperation(selectedId, currentUserId)?.requestId,
              controller.signal,
            ),
          ]);
          if (controller.signal.aborted) return;
          const marker = status.isOwner
            ? getPendingEndOperation(selectedId, currentUserId)
            : null;
          if (status.isOwner && status.connectionState === "completed")
            clearPendingEndOperation(selectedId, currentUserId);
          setDetail({
            messages: record.messages,
            status: applyPendingEndOperation(status, marker),
          });
        } else {
          const [items, overview] = await Promise.all([
            listConversations(controller.signal),
            listOverview(undefined, controller.signal),
          ]);
          if (controller.signal.aborted) return;
          setConversations(items);
          setStates(
            new Map(
              [...overview.pending, ...overview.recent].map((status) => [
                status.conversation.id,
                applyPendingEndOperation(
                  status,
                  getPendingEndOperation(status.conversation.id, currentUserId),
                ),
              ]),
            ),
          );
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (isUnauthorized(cause)) {
          onUnauthorized();
          return;
        }
        setError("暂时无法读取通话记录，请稍后重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [selectedId, currentUserId, reload, onUnauthorized]);

  useEffect(() => {
    if (!selectedId || !detail) return;
    const needsRefresh =
      detail.status.connectionState !== "completed" ||
      [detail.status.summary.state, detail.status.memory.state].some(
        (state) => state === "processing" || state === "not_started",
      );
    if (!needsRefresh) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible")
        setReload((current) => current + 1);
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [selectedId, detail]);

  const remove = async () => {
    if (
      !detail ||
      busy ||
      readOnly ||
      !detail.status.isOwner ||
      detail.status.conversation.userId !== currentUserId ||
      detail.status.connectionState !== "completed"
    )
      return;
    if (!window.confirm("确定删除这次通话和全部文字记录吗？")) return;
    setBusy(true);
    try {
      await deleteConversation(detail.status.conversation.id);
      clearPendingEndOperation(detail.status.conversation.id, currentUserId);
      setSelectedId(undefined);
      setDetail(null);
      setReload((current) => current + 1);
    } catch (cause) {
      if (isUnauthorized(cause)) {
        onUnauthorized();
        return;
      }
      setError("删除失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (
      !detail ||
      busy ||
      readOnly ||
      !detail.status.isOwner ||
      detail.status.conversation.userId !== currentUserId
    )
      return;
    setBusy(true);
    try {
      await onFinish(detail.status);
    } finally {
      setBusy(false);
      setReload((current) => current + 1);
    }
  };

  if (selectedId)
    return (
      <div className="history-detail page-frame">
        <button
          type="button"
          className="detail-back"
          onClick={() => {
            setSelectedId(undefined);
            setDetail(null);
          }}
        >
          ← 返回历史
        </button>
        {error && (
          <div className="product-notice error" role="alert">
            {error}
            <button
              type="button"
              onClick={() => setReload((current) => current + 1)}
            >
              重试
            </button>
          </div>
        )}
        {loading && !detail ? (
          <div className="history-empty" role="status">
            正在读取这次通话…
          </div>
        ) : (
          detail && (
            <HistoryDetailView
              status={detail.status}
              messages={detail.messages}
              currentUserId={currentUserId}
              readOnly={readOnly}
              busy={busy}
              onCall={onCall}
              onResume={onResume}
              onFinish={() => void finish()}
              onDelete={() => void remove()}
              onViewMemories={onViewMemories}
            />
          )
        )}
      </div>
    );

  return (
    <div className="history-page page-frame">
      <header className="history-heading">
        <div>
          <p className="product-eyebrow">CONVERSATIONS</p>
          <h1>通话历史</h1>
          <p>这里是当前账号的通话记录；临时对话也会保留文字。</p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => setReload((current) => current + 1)}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </header>
      {error && (
        <div className="product-notice error" role="alert">
          {error}
        </div>
      )}
      {loading && conversations.length === 0 ? (
        <div className="history-empty" role="status">
          正在读取通话记录…
        </div>
      ) : conversations.length === 0 ? (
        <div className="history-empty">
          <span aria-hidden="true">◷</span>
          <strong>还没有通话记录</strong>
          <p>从角色页开始一次通话，已确认的字幕会自动保存在这里。</p>
        </div>
      ) : (
        <div className="history-list">
          {conversations.map((conversation) => {
            const status = states.get(conversation.id);
            return (
              <button
                type="button"
                className="history-card"
                key={conversation.id}
                onClick={() => {
                  setSelectedId(conversation.id);
                  setDetail(null);
                }}
                style={
                  {
                    "--history-accent":
                      conversation.character.visualProfile.accentColor,
                  } as CSSProperties
                }
              >
                <img
                  src={conversation.character.visualProfile.avatarUrl}
                  alt=""
                />
                <span className="history-card-copy">
                  <span>
                    <strong>{conversation.character.name}</strong>
                    <em>
                      {conversation.mode === "temporary"
                        ? "临时对话"
                        : "普通通话"}
                    </em>
                    <em>
                      {status
                        ? conversationStateLabel(status)
                        : conversation.status === "completed"
                          ? "已结束"
                          : "正在确认通话状态"}
                    </em>
                  </span>
                  <small>
                    {formatConversationDate(
                      status?.lastActivityAt ?? conversation.startedAt,
                    )}
                  </small>
                  <span>{conversation.messageCount} 条文字记录</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function HistoryDetailView({
  status,
  messages,
  currentUserId,
  readOnly = false,
  busy,
  onCall,
  onResume,
  onFinish,
  onDelete,
  onViewMemories,
}: {
  status: ConversationContinuityStatus;
  messages: ConversationMessage[];
  currentUserId: string;
  readOnly?: boolean;
  busy: boolean;
  onCall: HistoryPageProps["onCall"];
  onResume: HistoryPageProps["onResume"];
  onFinish: () => void;
  onDelete: () => void;
  onViewMemories?: HistoryPageProps["onViewMemories"];
}) {
  const conversation = status.conversation;
  const viewingOther = conversation.userId !== currentUserId || !status.isOwner;
  const actions = conversationActions(status, readOnly || viewingOther);
  const temporary = conversation.mode === "temporary";
  return (
    <>
      <header>
        <img src={conversation.character.visualProfile.avatarUrl} alt="" />
        <div>
          <p className="product-eyebrow">
            {formatConversationDate(conversation.startedAt)}
          </p>
          <h1>与{conversation.character.name}的通话</h1>
          <p>
            {temporary
              ? "临时对话 · 不写入长期记忆"
              : "普通通话 · 后续可用于关系延续"}{" "}
            · {conversationStateLabel(status)}
          </p>
          <p className="continuity-muted">
            通话 {formatConnectedDuration(status.connectedDurationMs)}
            {status.lastActivityAt
              ? ` · 最后活动 ${formatConversationDate(status.lastActivityAt)}`
              : ""}
          </p>
          {status.lastSavedAt && (
            <p className="continuity-muted">
              最后已保存：{formatConversationDate(status.lastSavedAt)}
            </p>
          )}
        </div>
        <div className="history-detail-actions">
          {actions.resume && (
            <button
              className="product-primary-button"
              type="button"
              disabled={busy}
              onClick={() => onResume(status)}
            >
              {actions.resume}
            </button>
          )}
          {actions.start && (
            <button
              className="product-primary-button"
              type="button"
              disabled={busy}
              onClick={() =>
                onCall(conversation.character.id, conversation.mode)
              }
            >
              {actions.start}
            </button>
          )}
          {actions.finish && (
            <button type="button" disabled={busy} onClick={onFinish}>
              {busy ? "正在确认…" : "结束并保存"}
            </button>
          )}
          {actions.remove && (
            <button type="button" disabled={busy} onClick={onDelete}>
              {busy ? "正在处理…" : "删除记录"}
            </button>
          )}
        </div>
      </header>
      {viewingOther && (
        <p className="continuity-filter-note">
          你正在按账号设置只读查看该成员的历史，不能替该成员继续或修改通话。
        </p>
      )}
      {readOnly && !viewingOther && (
        <p className="continuity-filter-note">
          仅查看服务器已保存的记录。关闭后返回原通话，尚未同步的文字仍保留在原页面。
        </p>
      )}
      {status.unavailableReason === "in_use" && (
        <p className="continuity-filter-note">
          正在另一台设备或页面通话，请回到原页面继续。
        </p>
      )}
      {status.unavailableReason === "character_unavailable" && (
        <p className="continuity-filter-note">
          原角色或配置已不可用，无法恢复；已有记录仍可查看。
        </p>
      )}
      {actions.start && (
        <p className="continuity-filter-note">
          {temporary
            ? "新的临时对话不会带入以前的关系或这次已经结束的内容。"
            : "再次聊天会开启一次新通话并延续既有关系，不一定从这份记录的最后一句开始。"}
        </p>
      )}
      {status.connectionState === "completed" && (
        <ConversationReview
          status={status}
          onViewMemories={viewingOther || readOnly ? undefined : onViewMemories}
        />
      )}
      <section className="history-transcript" aria-label="通话文字记录">
        {messages.length === 0 ? (
          <div className="history-empty">这次通话没有已确认的字幕。</div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={`history-message ${message.role}`}
            >
              <strong>
                {message.role === "user"
                  ? viewingOther
                    ? "该成员"
                    : "你"
                  : conversation.character.name}
              </strong>
              <div>
                <p>{message.text}</p>
                <small>
                  {formatTime(message.createdAt)}
                  {message.status === "interrupted" ? " · 已被打断" : ""}
                </small>
              </div>
            </article>
          ))
        )}
      </section>
    </>
  );
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ConversationApiError && error.status === 401;
}
function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
