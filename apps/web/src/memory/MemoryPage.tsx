import type { CharacterMemory, ReviewMemoryRequest } from "@meet/protocol";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { MemoryApiError, listMemories, reviewMemory } from "./memory-api.js";

export default function MemoryPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [memories, setMemories] = useState<CharacterMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const suggested = useMemo(
    () => memories.filter((memory) => memory.status === "suggested"),
    [memories],
  );
  const active = useMemo(
    () => memories.filter((memory) => memory.status === "active"),
    [memories],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void listMemories(controller.signal)
      .then((items) => {
        setMemories(items);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof MemoryApiError && cause.status === 401) {
          onUnauthorized();
          return;
        }
        setError("暂时无法读取长期记忆，请稍后重试。");
        setLoading(false);
      });
    return () => controller.abort();
  }, [onUnauthorized, reload]);

  const perform = async (
    memory: CharacterMemory,
    action: ReviewMemoryRequest["action"],
  ) => {
    if (busyId) return;
    let input: ReviewMemoryRequest;
    if (action === "edit") {
      const content = window.prompt("修改这条长期记忆", memory.content)?.trim();
      if (!content || content === memory.content) return;
      input = { action, content };
    } else {
      if (
        action === "delete" &&
        !window.confirm("删除后，角色不会再使用这条长期记忆。继续吗？")
      )
        return;
      input = { action };
    }
    setBusyId(memory.id);
    setError("");
    try {
      const updated = await reviewMemory(memory.id, input);
      setMemories((current) =>
        updated.status === "active" || updated.status === "suggested"
          ? current.map((item) => (item.id === updated.id ? updated : item))
          : current.filter((item) => item.id !== updated.id),
      );
    } catch (cause) {
      if (cause instanceof MemoryApiError && cause.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        cause instanceof MemoryApiError
          ? cause.message
          : "记忆操作失败，请稍后重试。",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="memory-page page-frame">
      <header className="memory-heading">
        <div>
          <p className="product-eyebrow">MEMORY</p>
          <h1>长期记忆</h1>
          <p>只在当前账号与对应角色之间使用；临时对话不会写入这里。</p>
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
        <div className="memory-empty" role="status">
          正在读取长期记忆…
        </div>
      ) : memories.length === 0 ? (
        <div className="memory-empty">
          <span aria-hidden="true">◎</span>
          <strong>还没有长期记忆</strong>
          <p>完成普通通话后，明确事实会自动保存，存疑内容会先请你确认。</p>
        </div>
      ) : (
        <>
          {suggested.length > 0 && (
            <MemorySection
              title="待你确认"
              description="这些内容可能有用，但还不足以自动成为事实。"
              memories={suggested}
              busyId={busyId}
              onAction={(memory, action) => void perform(memory, action)}
            />
          )}
          {active.length > 0 && (
            <MemorySection
              title="已确认记忆"
              description="角色会在后续普通通话中自然使用这些信息。"
              memories={active}
              busyId={busyId}
              onAction={(memory, action) => void perform(memory, action)}
            />
          )}
        </>
      )}
    </div>
  );
}

function MemorySection({
  title,
  description,
  memories,
  busyId,
  onAction,
}: {
  title: string;
  description: string;
  memories: CharacterMemory[];
  busyId: string | null;
  onAction: (
    memory: CharacterMemory,
    action: ReviewMemoryRequest["action"],
  ) => void;
}) {
  return (
    <section className="memory-section">
      <header>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span>{memories.length}</span>
      </header>
      <div className="memory-grid">
        {memories.map((memory) => (
          <article
            className={`memory-card ${memory.status}`}
            key={memory.id}
            style={
              {
                "--memory-accent": memory.character.visualProfile.accentColor,
              } as CSSProperties
            }
          >
            <div className="memory-character">
              <img src={memory.character.visualProfile.avatarUrl} alt="" />
              <span>
                <strong>{memory.character.name}</strong>
                <small>
                  {memory.status === "suggested" ? "待确认建议" : "长期事实"}
                </small>
              </span>
            </div>
            <p className="memory-content">{memory.content}</p>
            <blockquote>来源：“{memory.sourceExcerpt}”</blockquote>
            <small className="memory-date">
              更新于 {formatDate(memory.updatedAt)}
            </small>
            <div className="memory-actions">
              {memory.status === "suggested" && (
                <>
                  <button
                    type="button"
                    className="product-primary-button"
                    disabled={busyId === memory.id}
                    onClick={() => onAction(memory, "accept")}
                  >
                    接受
                  </button>
                  <button
                    type="button"
                    disabled={busyId === memory.id}
                    onClick={() => onAction(memory, "reject")}
                  >
                    拒绝
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={busyId === memory.id}
                onClick={() => onAction(memory, "edit")}
              >
                编辑
              </button>
              {memory.status === "active" && (
                <button
                  type="button"
                  disabled={busyId === memory.id}
                  onClick={() => onAction(memory, "delete")}
                >
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
