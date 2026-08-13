import type { CharacterMemory, ReviewMemoryRequest } from "@meet/protocol";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { MemoryApiError, listMemories, reviewMemory } from "./memory-api.js";

type MemoryFilter = "all" | "suggested" | "active";

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
  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [characterId, setCharacterId] = useState("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");

  const suggestedCount = useMemo(
    () => memories.filter((memory) => memory.status === "suggested").length,
    [memories],
  );
  const activeCount = memories.length - suggestedCount;
  const characters = useMemo(
    () =>
      Array.from(
        new Map(
          memories.map((memory) => [memory.character.id, memory.character]),
        ).values(),
      ),
    [memories],
  );
  const filteredMemories = useMemo(
    () =>
      memories.filter(
        (memory) =>
          (filter === "all" || memory.status === filter) &&
          (characterId === "all" || memory.character.id === characterId),
      ),
    [characterId, filter, memories],
  );
  const groups = useMemo(
    () =>
      Array.from(
        filteredMemories
          .reduce((result, memory) => {
            const group = result.get(memory.character.id);
            if (group) group.memories.push(memory);
            else
              result.set(memory.character.id, {
                character: memory.character,
                memories: [memory],
              });
            return result;
          }, new Map<string, { character: CharacterMemory["character"]; memories: CharacterMemory[] }>())
          .values(),
      ),
    [filteredMemories],
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
    input: ReviewMemoryRequest,
  ) => {
    if (busyId) return;
    if (
      input.action === "delete" &&
      !window.confirm("删除后，角色不会再使用这条长期记忆。继续吗？")
    )
      return;
    setBusyId(memory.id);
    setError("");
    try {
      const updated = await reviewMemory(memory.id, input);
      setMemories((current) =>
        updated.status === "active" || updated.status === "suggested"
          ? current.map((item) => (item.id === updated.id ? updated : item))
          : current.filter((item) => item.id !== updated.id),
      );
      setEditingId(null);
      setEditingContent("");
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

  const beginEdit = (memory: CharacterMemory) => {
    setEditingId(memory.id);
    setEditingContent(memory.content);
  };

  return (
    <div className="memory-page page-frame">
      <header className="memory-heading">
        <div>
          <p className="product-eyebrow">MEMORY</p>
          <h1>长期记忆</h1>
          <p>按角色整理你们共同记住的事情，临时对话不会写入这里。</p>
        </div>
        <button
          type="button"
          className="ui-button ui-button-secondary"
          disabled={loading}
          onClick={() => setReload((current) => current + 1)}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </header>

      {!loading && memories.length > 0 && (
        <>
          <section className="memory-overview" aria-label="记忆概览">
            <button
              type="button"
              className={filter === "all" ? "selected" : ""}
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              <span>全部记忆</span>
              <strong>{memories.length}</strong>
              <small>角色已经了解的长期信息</small>
            </button>
            <button
              type="button"
              className={filter === "suggested" ? "selected" : ""}
              aria-pressed={filter === "suggested"}
              onClick={() => setFilter("suggested")}
            >
              <span>待确认</span>
              <strong>{suggestedCount}</strong>
              <small>
                {suggestedCount ? "需要你判断是否准确" : "当前没有待办"}
              </small>
            </button>
            <button
              type="button"
              className={filter === "active" ? "selected" : ""}
              aria-pressed={filter === "active"}
              onClick={() => setFilter("active")}
            >
              <span>已保存</span>
              <strong>{activeCount}</strong>
              <small>会在普通通话中自然使用</small>
            </button>
          </section>

          <div className="memory-character-filter" aria-label="按角色筛选">
            <button
              type="button"
              className={characterId === "all" ? "selected" : ""}
              aria-pressed={characterId === "all"}
              onClick={() => setCharacterId("all")}
            >
              全部角色
            </button>
            {characters.map((character) => (
              <button
                type="button"
                key={character.id}
                className={characterId === character.id ? "selected" : ""}
                aria-pressed={characterId === character.id}
                onClick={() => setCharacterId(character.id)}
              >
                <img src={character.visualProfile.avatarUrl} alt="" />
                {character.name}
              </button>
            ))}
          </div>
        </>
      )}

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
      ) : groups.length === 0 ? (
        <div className="memory-empty memory-filter-empty">
          <strong>这个分类里暂时没有内容</strong>
          <p>可以切换上方状态或角色筛选。</p>
        </div>
      ) : (
        <div className="memory-groups">
          {groups.map((group) => (
            <MemoryGroup
              key={group.character.id}
              character={group.character}
              memories={group.memories}
              busyId={busyId}
              editingId={editingId}
              editingContent={editingContent}
              onEditingContentChange={setEditingContent}
              onBeginEdit={beginEdit}
              onCancelEdit={() => {
                setEditingId(null);
                setEditingContent("");
              }}
              onAction={(memory, input) => void perform(memory, input)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryGroup({
  character,
  memories,
  busyId,
  editingId,
  editingContent,
  onEditingContentChange,
  onBeginEdit,
  onCancelEdit,
  onAction,
}: {
  character: CharacterMemory["character"];
  memories: CharacterMemory[];
  busyId: string | null;
  editingId: string | null;
  editingContent: string;
  onEditingContentChange: (value: string) => void;
  onBeginEdit: (memory: CharacterMemory) => void;
  onCancelEdit: () => void;
  onAction: (memory: CharacterMemory, input: ReviewMemoryRequest) => void;
}) {
  return (
    <section
      className="memory-group"
      style={
        {
          "--memory-accent": character.visualProfile.accentColor,
        } as CSSProperties
      }
    >
      <header className="memory-group-header">
        <img src={character.visualProfile.avatarUrl} alt="" />
        <div>
          <h2>{character.name}</h2>
          <p>你和这个角色共同保留的长期信息</p>
        </div>
        <span>{memories.length} 条</span>
      </header>
      <div className="memory-list">
        {memories.map((memory) => {
          const editing = editingId === memory.id;
          return (
            <article className={`memory-row ${memory.status}`} key={memory.id}>
              <div className="memory-row-main">
                <div className="memory-row-meta">
                  <span className={`memory-status ${memory.status}`}>
                    {memory.status === "suggested" ? "待确认" : "已保存"}
                  </span>
                  <time dateTime={memory.updatedAt}>
                    {formatDate(memory.updatedAt)}
                  </time>
                </div>
                {editing ? (
                  <label className="memory-editor">
                    <span>记忆内容</span>
                    <textarea
                      autoFocus
                      maxLength={1000}
                      value={editingContent}
                      onChange={(event) =>
                        onEditingContentChange(event.target.value)
                      }
                    />
                    <small>{editingContent.length} / 1000</small>
                  </label>
                ) : (
                  <p className="memory-content">{memory.content}</p>
                )}
                <details className="memory-source">
                  <summary>查看这条记忆的来源</summary>
                  <blockquote>“{memory.sourceExcerpt}”</blockquote>
                </details>
              </div>
              <div className="memory-actions">
                {editing ? (
                  <>
                    <button
                      type="button"
                      className="ui-button ui-button-primary"
                      disabled={
                        busyId === memory.id ||
                        !editingContent.trim() ||
                        editingContent.trim() === memory.content
                      }
                      onClick={() =>
                        onAction(memory, {
                          action: "edit",
                          content: editingContent.trim(),
                        })
                      }
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="ui-button ui-button-ghost"
                      disabled={busyId === memory.id}
                      onClick={onCancelEdit}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    {memory.status === "suggested" && (
                      <button
                        type="button"
                        className="ui-button ui-button-primary"
                        disabled={busyId === memory.id}
                        onClick={() => onAction(memory, { action: "accept" })}
                      >
                        确认保存
                      </button>
                    )}
                    <button
                      type="button"
                      className="ui-button ui-button-secondary"
                      disabled={Boolean(busyId || editingId)}
                      onClick={() => onBeginEdit(memory)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ui-button ui-button-ghost danger"
                      disabled={busyId === memory.id}
                      onClick={() =>
                        onAction(memory, {
                          action:
                            memory.status === "suggested" ? "reject" : "delete",
                        })
                      }
                    >
                      {memory.status === "suggested" ? "忽略" : "删除"}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
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
