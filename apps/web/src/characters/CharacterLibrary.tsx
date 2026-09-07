import type {
  CharacterSummary,
  ConversationContinuityStatus,
  UserAccount,
} from "@meet/protocol";
import { useState, type CSSProperties } from "react";

import {
  conversationActions,
  conversationStateLabel,
  formatConversationDate,
} from "../history/continuity-presentation.js";

import { canCreateCharacter } from "./character-logic.js";

type CharacterLibraryProps = {
  user: UserAccount;
  characters: CharacterSummary[];
  loading: boolean;
  error: string;
  busyCharacterId: string | null;
  onRetry: () => void;
  onOpen: (characterId: string) => void;
  onCall: (characterId: string) => void;
  onCreate: () => void;
  pending: ConversationContinuityStatus[];
  recent: ConversationContinuityStatus[];
  overviewLoading: boolean;
  overviewError: string;
  favoriteIds: string[];
  favoriteBusyId: string | null;
  onToggleFavorite: (characterId: string) => void;
  onResume: (status: ConversationContinuityStatus) => void;
  onFinish: (status: ConversationContinuityStatus) => void;
  onViewHistory: (conversationId: string) => void;
  onRefreshOverview: () => void;
};

export default function CharacterLibrary({
  user,
  characters,
  loading,
  error,
  busyCharacterId,
  onRetry,
  onOpen,
  onCall,
  onCreate,
  pending,
  recent,
  overviewLoading,
  overviewError,
  favoriteIds,
  favoriteBusyId,
  onToggleFavorite,
  onResume,
  onFinish,
  onViewHistory,
  onRefreshOverview,
}: CharacterLibraryProps) {
  const [showAllPending, setShowAllPending] = useState(false);
  const favorites = characters.filter((character) =>
    favoriteIds.includes(character.id),
  );
  const visibleRecent = recent
    .filter(
      (status) =>
        status.conversation.mode === "normal" &&
        status.connectionState === "completed",
    )
    .flatMap((status) => {
      const character = characters.find(
        (item) => item.id === status.conversation.character.id,
      );
      return character ? [{ character, status }] : [];
    });
  const renderCharacter = (
    character: CharacterSummary,
    lastChat?: string,
    compact = false,
  ) => (
    <CharacterCard
      key={character.id}
      character={character}
      callPending={busyCharacterId === character.id}
      favorite={favoriteIds.includes(character.id)}
      favoritePending={favoriteBusyId === character.id}
      onToggleFavorite={() => onToggleFavorite(character.id)}
      lastChat={lastChat}
      compact={compact}
      onOpen={() => onOpen(character.id)}
      onCall={() => onCall(character.id)}
    />
  );
  return (
    <div className="character-library page-frame">
      <header className="library-heading">
        <div>
          <p className="product-eyebrow">FAMILY CHARACTERS</p>
          <h1>今天想和谁聊聊？</h1>
          <p>选择一个熟悉的角色，声音、人设和开场方式都会自动准备好。</p>
        </div>
        {canCreateCharacter(user) && (
          <button
            className="product-primary-button"
            type="button"
            onClick={onCreate}
          >
            <span aria-hidden="true">＋</span>
            创建角色
          </button>
        )}
      </header>

      {overviewLoading && (
        <p className="continuity-loading" role="status">
          正在确认最近的通话…
        </p>
      )}
      {overviewError && (
        <div className="product-notice error" role="alert">
          {overviewError}
          <button type="button" onClick={onRefreshOverview}>
            重新确认
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <section
          className="continuity-pending-section"
          aria-labelledby="pending-conversations-title"
        >
          <div className="section-title-row">
            <h2 id="pending-conversations-title">需要处理的通话</h2>
            <button type="button" onClick={onRefreshOverview}>
              刷新状态
            </button>
          </div>
          {(showAllPending ? pending : pending.slice(0, 1)).map((status) => (
            <PendingConversationCard
              key={status.conversation.id}
              status={status}
              busy={busyCharacterId === status.conversation.id}
              onResume={() => onResume(status)}
              onFinish={() => onFinish(status)}
              onView={() => onViewHistory(status.conversation.id)}
            />
          ))}
          {pending.length > 1 && (
            <button
              className="continuity-more-pending"
              type="button"
              onClick={() => setShowAllPending((current) => !current)}
            >
              {showAllPending
                ? "收起其他通话"
                : `还有 ${pending.length - 1} 次待处理`}
            </button>
          )}
        </section>
      )}
      {visibleRecent.length > 0 && (
        <section
          className="library-section"
          aria-labelledby="recent-characters-title"
        >
          <div className="section-title-row">
            <h2 id="recent-characters-title">最近聊过</h2>
          </div>
          <div className="continuity-compact-grid">
            {visibleRecent.map(({ character, status }) =>
              renderCharacter(
                character,
                status.lastActivityAt ??
                  status.conversation.endedAt ??
                  status.conversation.updatedAt,
                true,
              ),
            )}
          </div>
        </section>
      )}
      {favorites.length > 0 && (
        <section
          className="library-section"
          aria-labelledby="favorite-characters-title"
        >
          <div className="section-title-row">
            <h2 id="favorite-characters-title">收藏</h2>
          </div>
          <div className="continuity-compact-grid">
            {favorites.map((character) =>
              renderCharacter(character, undefined, true),
            )}
          </div>
        </section>
      )}

      <section
        className="library-section"
        aria-labelledby="character-list-title"
      >
        <div className="section-title-row">
          <div>
            <p className="product-eyebrow">YOUR CAST</p>
            <h2 id="character-list-title">全部角色</h2>
          </div>
          {!loading && !error && (
            <span className="section-count">{characters.length} 位角色</span>
          )}
        </div>

        {loading && (
          <div className="product-state" role="status">
            <span className="product-spinner" aria-hidden="true" />
            <strong>正在准备角色</strong>
            <p>马上就好。</p>
          </div>
        )}

        {!loading && error && (
          <div className="product-state error" role="alert">
            <span className="state-symbol" aria-hidden="true">
              !
            </span>
            <strong>角色暂时没有出现</strong>
            <p>{error}</p>
            <button type="button" onClick={onRetry}>
              重新加载
            </button>
          </div>
        )}

        {!loading && !error && characters.length === 0 && (
          <div className="product-state">
            <span className="state-symbol" aria-hidden="true">
              M
            </span>
            <strong>这里还没有角色</strong>
            <p>
              {canCreateCharacter(user)
                ? "创建第一个角色，或请管理员检查预置角色是否已经初始化。"
                : "请让家庭管理员准备一个家庭共享角色。"}
            </p>
            {canCreateCharacter(user) && (
              <button type="button" onClick={onCreate}>
                创建角色
              </button>
            )}
          </div>
        )}

        {!loading && !error && characters.length > 0 && (
          <div className="character-grid">
            {characters.map((character) => renderCharacter(character))}
          </div>
        )}
      </section>
    </div>
  );
}

type CharacterCardProps = {
  character: CharacterSummary;
  callPending: boolean;
  onOpen: () => void;
  onCall: () => void;
  favorite: boolean;
  favoritePending: boolean;
  onToggleFavorite: () => void;
  lastChat?: string;
  compact?: boolean;
};

function CharacterCard({
  character,
  callPending,
  onOpen,
  onCall,
  favorite,
  favoritePending,
  onToggleFavorite,
  lastChat,
  compact = false,
}: CharacterCardProps) {
  return (
    <article
      className={`character-card character-bg-${character.visualProfile.background}${compact ? " continuity-compact-card" : ""}`}
      style={
        {
          "--character-accent": character.visualProfile.accentColor,
        } as CSSProperties
      }
    >
      <button
        className="character-card-main"
        type="button"
        onClick={onOpen}
        aria-label={`查看 ${character.name} 的详情`}
      >
        <span className="character-card-art" aria-hidden="true">
          <img src={character.visualProfile.avatarUrl} alt="" />
        </span>
        <span className="character-card-copy">
          {!compact && (
            <span className="character-card-meta">
              <VisibilityBadge visibility={character.visibility} />
              {character.systemKey && (
                <span className="preset-badge">预置</span>
              )}
            </span>
          )}
          <strong>{character.name}</strong>
          {!compact && (
            <span className="character-description">
              {character.description}
            </span>
          )}
          <span className="character-voice">
            {lastChat
              ? `上次聊天：${formatConversationDate(lastChat)}`
              : `声音 · ${character.voiceProfile.displayName}`}
          </span>
        </span>
      </button>
      <div className="character-card-footer">
        <button
          className="character-detail-link"
          type="button"
          onClick={onToggleFavorite}
          disabled={favoritePending}
          aria-pressed={favorite}
          aria-label={`${favorite ? "取消收藏" : "收藏"}${character.name}`}
        >
          <span aria-hidden="true">{favorite ? "★" : "☆"}</span>{" "}
          {favorite ? "已收藏" : "收藏"}
        </button>
        <button
          className="character-call-button"
          type="button"
          disabled={
            callPending || character.realtimeAvailability?.available === false
          }
          onClick={onCall}
        >
          <span aria-hidden="true">{callPending ? "…" : "●"}</span>
          {callPending
            ? "准备中"
            : character.realtimeAvailability?.available === false
              ? "模型不可用"
              : lastChat
                ? "再次聊天"
                : "通话"}
        </button>
      </div>
    </article>
  );
}

export function PendingConversationCard({
  status,
  busy,
  onResume,
  onFinish,
  onView,
}: {
  status: ConversationContinuityStatus;
  busy: boolean;
  onResume: () => void;
  onFinish: () => void;
  onView: () => void;
}) {
  const actions = conversationActions(status);
  const conversation = status.conversation;
  return (
    <article className="continuity-pending-card">
      <button
        type="button"
        className="continuity-pending-main"
        onClick={onView}
      >
        <img src={conversation.character.visualProfile.avatarUrl} alt="" />
        <span>
          <strong>{conversation.character.name}</strong>
          <span>
            {conversation.mode === "temporary" ? "临时对话" : "普通通话"} ·{" "}
            {conversationStateLabel(status)}
          </span>
          <small>
            最后活动：
            {formatConversationDate(
              status.lastActivityAt ?? conversation.startedAt,
            )}
          </small>
          <small>
            {status.lastSavedAt
              ? `最后已保存：${formatConversationDate(status.lastSavedAt)}`
              : "尚无已保存文字"}
          </small>
        </span>
      </button>
      {status.unavailableReason === "in_use" && (
        <p>正在另一台设备或页面通话，请回到原页面继续。</p>
      )}
      {status.unavailableReason === "character_unavailable" && (
        <p>原角色或配置已不可用；仍可查看和结束已有记录。</p>
      )}
      <div className="continuity-actions">
        {actions.resume && (
          <button
            type="button"
            className="product-primary-button"
            disabled={busy}
            onClick={onResume}
          >
            {busy ? "正在准备…" : actions.resume}
          </button>
        )}
        {actions.finish && (
          <button type="button" disabled={busy} onClick={onFinish}>
            {busy ? "正在确认…" : "结束并保存"}
          </button>
        )}
        <button type="button" onClick={onView}>
          查看记录
        </button>
      </div>
    </article>
  );
}

export function VisibilityBadge({
  visibility,
}: {
  visibility: CharacterSummary["visibility"];
}) {
  const labels = {
    builtin: "全家可用",
    family: "家庭共享",
    private: "仅自己",
  } as const;
  return (
    <span className={`visibility-badge ${visibility}`}>
      {labels[visibility]}
    </span>
  );
}
