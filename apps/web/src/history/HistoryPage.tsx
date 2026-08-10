import type { ConversationMessage, ConversationSummary } from "@meet/protocol";
import { useEffect, useState, type CSSProperties } from "react";

import {
  ConversationApiError,
  deleteConversation,
  getConversation,
  listConversations,
} from "./conversation-api.js";

type DetailState =
  | { status: "closed" }
  | { status: "loading"; id: string }
  | {
      status: "ready";
      conversation: ConversationSummary;
      messages: ConversationMessage[];
    }
  | { status: "error"; id: string; message: string };

export default function HistoryPage({
  onCall,
  onUnauthorized,
}: {
  onCall: (characterId: string) => void;
  onUnauthorized: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<DetailState>({ status: "closed" });
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void listConversations(controller.signal)
      .then((items) => {
        setConversations(items);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(cause)) {
          onUnauthorized();
          return;
        }
        setError("暂时无法读取通话历史，请稍后重试。");
        setLoading(false);
      });
    return () => controller.abort();
  }, [onUnauthorized, reload]);

  useEffect(() => {
    if (detail.status !== "loading") return;
    const controller = new AbortController();
    const id = detail.id;
    void getConversation(id, controller.signal)
      .then((value) => setDetail({ status: "ready", ...value }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(cause)) {
          onUnauthorized();
          return;
        }
        setDetail({
          status: "error",
          id,
          message: "暂时无法读取这次通话，请稍后重试。",
        });
      });
    return () => controller.abort();
  }, [detail, onUnauthorized]);

  const remove = async () => {
    if (detail.status !== "ready" || deleting) return;
    if (!window.confirm("确定删除这次通话和全部文字记录吗？")) return;
    setDeleting(true);
    try {
      await deleteConversation(detail.conversation.id);
      setDetail({ status: "closed" });
      setReload((current) => current + 1);
    } catch (cause) {
      if (isUnauthorized(cause)) {
        onUnauthorized();
        return;
      }
      setDetail({
        ...detail,
        status: "error",
        id: detail.conversation.id,
        message: "删除失败，请稍后重试。",
      });
    } finally {
      setDeleting(false);
    }
  };

  if (detail.status !== "closed") {
    return (
      <HistoryDetail
        state={detail}
        deleting={deleting}
        onBack={() => setDetail({ status: "closed" })}
        onRetry={(id) => setDetail({ status: "loading", id })}
        onCall={onCall}
        onDelete={() => void remove()}
      />
    );
  }

  return (
    <div className="history-page page-frame">
      <header className="history-heading">
        <div>
          <p className="product-eyebrow">CONVERSATIONS</p>
          <h1>通话历史</h1>
          <p>每个账号只保存和读取自己的私人通话；临时对话也会保留文字记录。</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => setReload((current) => current + 1)}
        >
          刷新
        </button>
      </header>
      {error && (
        <div className="product-notice error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
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
          {conversations.map((conversation) => (
            <button
              type="button"
              className="history-card"
              key={conversation.id}
              onClick={() =>
                setDetail({ status: "loading", id: conversation.id })
              }
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
                  {conversation.mode === "temporary" && <em>临时对话</em>}
                  {conversation.status === "active" && <em>未正常结束</em>}
                </span>
                <small>{formatDate(conversation.startedAt)}</small>
                <span>{conversation.messageCount} 条文字记录</span>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryDetail({
  state,
  deleting,
  onBack,
  onRetry,
  onCall,
  onDelete,
}: {
  state: Exclude<DetailState, { status: "closed" }>;
  deleting: boolean;
  onBack: () => void;
  onRetry: (id: string) => void;
  onCall: (characterId: string) => void;
  onDelete: () => void;
}) {
  if (state.status === "loading") {
    return (
      <div className="history-detail page-frame">
        <button type="button" className="detail-back" onClick={onBack}>
          ← 返回历史
        </button>
        <div className="history-empty" role="status">
          正在读取通话内容…
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="history-detail page-frame">
        <button type="button" className="detail-back" onClick={onBack}>
          ← 返回历史
        </button>
        <div className="history-empty" role="alert">
          <strong>{state.message}</strong>
          <button type="button" onClick={() => onRetry(state.id)}>
            重试
          </button>
        </div>
      </div>
    );
  }
  const { conversation, messages } = state;
  return (
    <div className="history-detail page-frame">
      <button type="button" className="detail-back" onClick={onBack}>
        ← 返回历史
      </button>
      <header>
        <img src={conversation.character.visualProfile.avatarUrl} alt="" />
        <div>
          <p className="product-eyebrow">
            {formatDate(conversation.startedAt)}
          </p>
          <h1>与{conversation.character.name}的通话</h1>
          <p>
            {conversation.mode === "temporary"
              ? "临时对话 · 不写入长期记忆"
              : "普通对话 · 后续可用于关系延续"}
            {conversation.status === "active" ? " · 通话未正常结束" : ""}
          </p>
        </div>
        <div className="history-detail-actions">
          <button
            type="button"
            className="product-primary-button"
            onClick={() => onCall(conversation.character.id)}
          >
            再次通话
          </button>
          <button type="button" disabled={deleting} onClick={onDelete}>
            {deleting ? "删除中…" : "删除记录"}
          </button>
        </div>
      </header>
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
                {message.role === "user" ? "你" : conversation.character.name}
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
    </div>
  );
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ConversationApiError && error.status === 401;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
