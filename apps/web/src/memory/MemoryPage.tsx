import type {
  CharacterMemory,
  Mem0DiagnosticsResponse,
  Mem0SearchResponse,
  ReviewMemoryRequest,
} from "@meet/protocol";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import {
  getMem0Diagnostics,
  MemoryApiError,
  listMemories,
  reviewMemory,
  searchMem0,
} from "./memory-api.js";

type MemoryFilter = "all" | "suggested" | "active";

export default function MemoryPage({
  onUnauthorized,
  initialCharacterId,
  sourceConversationId: initialSourceConversationId,
  initialStatus = "all",
  onViewHistory,
}: {
  onUnauthorized: () => void;
  initialCharacterId?: string;
  sourceConversationId?: string;
  initialStatus?: MemoryFilter;
  onViewHistory?: (conversationId: string) => void;
}) {
  const [memories, setMemories] = useState<CharacterMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemoryFilter>(initialStatus);
  const [characterId, setCharacterId] = useState(initialCharacterId ?? "all");
  const [sourceConversationId, setSourceConversationId] = useState(
    initialSourceConversationId,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

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
    void listMemories(controller.signal, {
      characterId: characterId === "all" ? undefined : characterId,
      sourceConversationId,
    })
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
  }, [onUnauthorized, reload, characterId, sourceConversationId]);

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
        <div className="memory-heading-actions">
          <button
            type="button"
            className="ui-button ui-button-secondary"
            onClick={() => setDiagnosticsOpen((current) => !current)}
          >
            {diagnosticsOpen ? "关闭 Mem0 诊断" : "Mem0 诊断"}
          </button>
          <button
            type="button"
            className="ui-button ui-button-secondary"
            disabled={loading}
            onClick={() => setReload((current) => current + 1)}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {(sourceConversationId || characterId !== "all") && (
        <section className="continuity-filter-note" aria-label="记忆范围">
          <span>
            {sourceConversationId
              ? "仅显示这次通话产生的记忆"
              : "仅显示当前角色的记忆"}
          </span>
          {sourceConversationId && onViewHistory && (
            <button
              type="button"
              onClick={() => onViewHistory(sourceConversationId)}
            >
              查看来源通话
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setSourceConversationId(undefined);
              setCharacterId("all");
              setFilter("all");
            }}
          >
            查看全部记忆
          </button>
        </section>
      )}

      {diagnosticsOpen && (
        <Mem0Diagnostics
          characters={characters}
          onUnauthorized={onUnauthorized}
        />
      )}

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
          <strong>
            {sourceConversationId
              ? "这次通话还没有可见的长期记忆"
              : "还没有长期记忆"}
          </strong>
          <p>
            {sourceConversationId
              ? "刚结束的普通通话可能仍在整理，可以稍后刷新。临时对话不新增长期记忆。"
              : "完成普通通话后，明确事实会自动保存，存疑内容会先请你确认。"}
          </p>
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
              onViewHistory={onViewHistory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Mem0Diagnostics({
  characters,
  onUnauthorized,
}: {
  characters: CharacterMemory["character"][];
  onUnauthorized: () => void;
}) {
  const [diagnostics, setDiagnostics] =
    useState<Mem0DiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [characterId, setCharacterId] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<Mem0SearchResponse | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getMem0Diagnostics(controller.signal)
      .then((result) => {
        setDiagnostics(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof MemoryApiError && cause.status === 401) {
          onUnauthorized();
          return;
        }
        setError(
          cause instanceof MemoryApiError
            ? cause.message
            : "无法读取 Mem0 诊断信息。",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [onUnauthorized, reload]);

  const visibleItems = diagnostics?.items.filter(
    (item) => !characterId || item.character.id === characterId,
  );
  const diagnosticCharacters = Array.from(
    new Map(
      [
        ...characters,
        ...(diagnostics?.items.map((item) => item.character) ?? []),
      ].map((character) => [character.id, character]),
    ).values(),
  );
  const mismatches =
    diagnostics?.enabled === true
      ? diagnostics.items.filter(
          (item) =>
            (item.expectedInMem0 && !item.existsInMem0) ||
            item.contentMatches === false ||
            item.indexStatus === "failed",
        ).length
      : 0;

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!characterId || !query.trim() || searching) return;
    setSearching(true);
    setError("");
    try {
      setSearchResult(await searchMem0({ characterId, query: query.trim() }));
    } catch (cause) {
      if (cause instanceof MemoryApiError && cause.status === 401) {
        onUnauthorized();
        return;
      }
      setError(
        cause instanceof MemoryApiError ? cause.message : "Mem0 检索测试失败。",
      );
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="mem0-diagnostics" aria-label="Mem0 诊断">
      <header>
        <div>
          <h2>Mem0 索引诊断</h2>
          <p>对照业务记忆与 Mem0 中的真实记录，并测试语义召回。</p>
        </div>
        <button
          type="button"
          className="ui-button ui-button-ghost"
          disabled={loading}
          onClick={() => setReload((current) => current + 1)}
        >
          {loading ? "读取中…" : "重新检查"}
        </button>
      </header>

      {error && (
        <div className="product-notice error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="mem0-diagnostics-loading">正在读取 Mem0 索引…</p>
      ) : diagnostics ? (
        <>
          <div className="mem0-diagnostics-summary">
            <div>
              <span>状态</span>
              <strong>{diagnostics.enabled ? "已启用" : "未启用"}</strong>
            </div>
            <div>
              <span>业务记忆</span>
              <strong>{diagnostics.items.length}</strong>
            </div>
            <div>
              <span>异常</span>
              <strong>{mismatches}</strong>
            </div>
            <div>
              <span>孤儿记录</span>
              <strong>{diagnostics.orphaned.length}</strong>
            </div>
          </div>
          {diagnostics.indexRevision && (
            <p className="mem0-index-revision">
              索引修订：<code>{diagnostics.indexRevision}</code>
            </p>
          )}

          <label className="mem0-character-select">
            角色范围
            <select
              value={characterId}
              onChange={(event) => {
                setCharacterId(event.target.value);
                setSearchResult(null);
              }}
            >
              <option value="">全部角色</option>
              {diagnosticCharacters.map((character) => (
                <option value={character.id} key={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>

          <div className="mem0-record-list">
            {visibleItems?.map((item) => (
              <article className="mem0-record" key={item.memoryId}>
                <header>
                  <strong>{item.character.name}</strong>
                  <span className={`mem0-index-status ${item.indexStatus}`}>
                    {mem0IndexStatusLabel(item.indexStatus)}
                  </span>
                </header>
                <p>{item.content}</p>
                <dl>
                  <div>
                    <dt>业务 ID</dt>
                    <dd>{item.memoryId}</dd>
                  </div>
                  <div>
                    <dt>Mem0 ID</dt>
                    <dd>{item.externalId ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>实际存在</dt>
                    <dd>{item.existsInMem0 ? "是" : "否"}</dd>
                  </div>
                  <div>
                    <dt>同步尝试</dt>
                    <dd>{item.attemptCount}</dd>
                  </div>
                </dl>
                {item.lastErrorCode && (
                  <p className="mem0-record-error">
                    最近错误：{item.lastErrorCode}
                  </p>
                )}
                {item.mem0Content && (
                  <details>
                    <summary>
                      查看 Mem0 中的正文
                      {item.contentMatches === false
                        ? "（与业务库不一致）"
                        : ""}
                    </summary>
                    <blockquote>{item.mem0Content}</blockquote>
                  </details>
                )}
              </article>
            ))}
          </div>

          {diagnostics.orphaned.length > 0 && (
            <details className="mem0-orphans">
              <summary>查看 {diagnostics.orphaned.length} 条孤儿记录</summary>
              {diagnostics.orphaned.map((item) => (
                <article key={item.externalId}>
                  <code>{item.externalId}</code>
                  <p>{item.content}</p>
                  <small>业务 ID：{item.localMemoryId ?? "缺失"}</small>
                </article>
              ))}
            </details>
          )}

          <form className="mem0-search-test" onSubmit={runSearch}>
            <h3>语义召回测试</h3>
            <p>选择一个角色并输入查询，结果来自当前 Mem0 索引。</p>
            <label>
              查询文本
              <input
                value={query}
                maxLength={1000}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：我平时喜欢做什么？"
              />
            </label>
            <button
              type="submit"
              className="ui-button ui-button-primary"
              disabled={
                !diagnostics.enabled ||
                !characterId ||
                !query.trim() ||
                searching
              }
            >
              {searching ? "检索中…" : "测试检索"}
            </button>
            {!characterId && <small>请先在上方选择具体角色。</small>}
          </form>

          {searchResult && (
            <div className="mem0-search-results">
              <h3>命中结果（{searchResult.results.length}）</h3>
              {searchResult.results.length === 0 ? (
                <p>没有达到条件的记忆。</p>
              ) : (
                searchResult.results.map((item, index) => (
                  <article key={item.externalId}>
                    <strong>#{index + 1}</strong>
                    <span>
                      分数：
                      {item.score === null ? "—" : item.score.toFixed(4)}
                    </span>
                    <p>{item.content}</p>
                    <small>Mem0 ID：{item.externalId}</small>
                  </article>
                ))
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function mem0IndexStatusLabel(
  status: Mem0DiagnosticsResponse["items"][number]["indexStatus"],
) {
  return {
    not_indexed: "未建索引",
    pending: "等待同步",
    synced: "已同步",
    failed: "同步失败",
  }[status];
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
  onViewHistory,
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
  onViewHistory?: (conversationId: string) => void;
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
                  {memory.sourceConversationId && onViewHistory && (
                    <button
                      type="button"
                      onClick={() =>
                        onViewHistory(memory.sourceConversationId!)
                      }
                    >
                      查看来源通话
                    </button>
                  )}
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
