import type { Character, UserAccount } from "@meet/protocol";
import { useRef, type CSSProperties } from "react";

import { getCharacterActionVisibility } from "./character-logic.js";
import { VisibilityBadge } from "./CharacterLibrary.js";
import { useConversationOverview } from "../history/use-conversation-overview.js";
import {
  analysisStateLabel,
  formatConversationDate,
} from "../history/continuity-presentation.js";
import type { MemoryLocation } from "../history/ConversationReview.js";

type CharacterDetailProps = {
  user: UserAccount;
  character: Character;
  busyAction: string | null;
  notice: { kind: "success" | "error"; message: string } | null;
  onBack: () => void;
  onCall: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onToggleVisibility: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onExportRelationship: () => void;
  onImportRelationship: (file: File) => void;
  favorite: boolean;
  favoritePending: boolean;
  onToggleFavorite: () => void;
  onViewHistory: (conversationId: string) => void;
  onViewMemories: (location: MemoryLocation) => void;
  onUnauthorized: () => void;
};

export default function CharacterDetail({
  user,
  character,
  busyAction,
  notice,
  onBack,
  onCall,
  onEdit,
  onCopy,
  onToggleVisibility,
  onRestore,
  onDelete,
  onExportRelationship,
  onImportRelationship,
  favorite,
  favoritePending,
  onToggleFavorite,
  onViewHistory,
  onViewMemories,
  onUnauthorized,
}: CharacterDetailProps) {
  const importInput = useRef<HTMLInputElement>(null);
  const actions = getCharacterActionVisibility(user, character.permissions);
  const policy = character.conversationPolicy;
  const usesCustomPrompt = character.persona.definitionMode === "custom_prompt";
  const {
    overview,
    loading: relationshipLoading,
    error: relationshipError,
  } = useConversationOverview({
    userId: user.id,
    characterId: character.id,
    onUnauthorized,
  });
  const latest = overview.recent[0];

  return (
    <div
      className={`character-detail page-frame character-bg-${character.visualProfile.background}`}
      style={
        {
          "--character-accent": character.visualProfile.accentColor,
        } as CSSProperties
      }
    >
      <button className="back-button" type="button" onClick={onBack}>
        <span aria-hidden="true">←</span> 返回角色
      </button>

      {notice && (
        <div
          className={`product-notice ${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}

      <section className="detail-hero">
        <div className="detail-portrait">
          <img
            src={character.visualProfile.avatarUrl}
            alt={`${character.name} 的头像`}
          />
        </div>
        <div className="detail-intro">
          <div className="character-card-meta">
            <VisibilityBadge visibility={character.visibility} />
            {character.systemKey && (
              <span className="preset-badge">预置角色</span>
            )}
          </div>
          <h1>{character.name}</h1>
          <p>{character.description}</p>
          <div className="detail-call-row">
            <button
              className="product-primary-button detail-call"
              type="button"
              disabled={Boolean(busyAction)}
              onClick={onCall}
            >
              <span aria-hidden="true">●</span>
              {busyAction === "call" ? "正在准备…" : `和${character.name}通话`}
            </button>
            <span className="detail-voice">
              {character.voiceProfile.displayName}
            </span>
            <button
              type="button"
              className="continuity-favorite"
              disabled={favoritePending}
              aria-pressed={favorite}
              onClick={onToggleFavorite}
            >
              {favorite ? "★ 已收藏" : "☆ 收藏角色"}
            </button>
          </div>
        </div>
      </section>

      <section
        className="detail-card continuity-relationship"
        aria-labelledby="relationship-title"
      >
        <div className="section-title-row">
          <h2 id="relationship-title">我和{character.name}的聊天</h2>
          <button
            type="button"
            onClick={() => onViewMemories({ characterId: character.id })}
          >
            查看我们的记忆
          </button>
        </div>
        {relationshipLoading ? (
          <p role="status">正在读取最近的聊天…</p>
        ) : relationshipError ? (
          <p role="status">{relationshipError}</p>
        ) : latest ? (
          <>
            <p className="continuity-muted">
              最近一次普通通话 ·{" "}
              {formatConversationDate(
                latest.lastActivityAt ?? latest.conversation.updatedAt,
              )}
            </p>
            {latest.summary.state === "completed" && latest.summary.content ? (
              <details className="continuity-recap">
                <summary>
                  <span>{latest.summary.content}</span>
                  <small>展开完整回顾</small>
                </summary>
                <p>{latest.summary.content}</p>
              </details>
            ) : (
              <p>
                {analysisStateLabel(latest.summary.state, "summary")} ·{" "}
                {latest.conversation.messageCount} 条文字记录
              </p>
            )}
            <button
              type="button"
              onClick={() => onViewHistory(latest.conversation.id)}
            >
              查看文字记录
            </button>
            <div className="continuity-memory-links">
              <span>最近通话的记忆</span>
              {latest.memory.state === "completed" ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      onViewMemories({
                        characterId: character.id,
                        sourceConversationId: latest.conversation.id,
                        status: "active",
                      })
                    }
                  >
                    已保存 {latest.memory.activeCount} 条
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onViewMemories({
                        characterId: character.id,
                        sourceConversationId: latest.conversation.id,
                        status: "suggested",
                      })
                    }
                  >
                    待确认 {latest.memory.suggestedCount} 条
                  </button>
                </>
              ) : (
                <p>{analysisStateLabel(latest.memory.state, "memory")}</p>
              )}
            </div>
          </>
        ) : (
          <p>
            还没有结束的普通通话。开始聊天后，你们的文字记录和回顾会在这里相伴。
          </p>
        )}
      </section>
      {overview.recent.length > 0 && (
        <section
          className="detail-card continuity-recent-history"
          aria-labelledby="character-recent-title"
        >
          <h2 id="character-recent-title">最近普通通话</h2>
          {overview.recent.map((status) => (
            <button
              type="button"
              key={status.conversation.id}
              onClick={() => onViewHistory(status.conversation.id)}
            >
              <span>
                {formatConversationDate(
                  status.lastActivityAt ?? status.conversation.updatedAt,
                )}
              </span>
              <span>
                {status.conversation.messageCount} 条文字记录{" "}
                <span aria-hidden="true">→</span>
              </span>
            </button>
          ))}
        </section>
      )}

      <details className="continuity-character-more">
        <summary>
          更多角色设置<span>人设、声音、角色操作与数据迁移</span>
        </summary>

        {(actions.canEdit ||
          actions.canCopy ||
          actions.canShare ||
          actions.canRestore ||
          actions.canDelete) && (
          <section className="detail-actions" aria-label="角色操作">
            {actions.canEdit && (
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={onEdit}
              >
                编辑角色
              </button>
            )}
            {actions.canCopy && (
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={onCopy}
              >
                {busyAction === "copy" ? "正在复制…" : "复制角色"}
              </button>
            )}
            {actions.canShare && (
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={onToggleVisibility}
              >
                {busyAction === "share"
                  ? "正在保存…"
                  : character.visibility === "private"
                    ? "共享给全家"
                    : "改为仅自己"}
              </button>
            )}
            {actions.canRestore && (
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={onRestore}
              >
                {busyAction === "restore" ? "正在恢复…" : "恢复预置版本"}
              </button>
            )}
            {actions.canDelete && (
              <button
                className="danger"
                type="button"
                disabled={Boolean(busyAction)}
                onClick={onDelete}
              >
                {busyAction === "delete" ? "正在删除…" : "删除角色"}
              </button>
            )}
          </section>
        )}

        <section className="detail-card relationship-transfer-card">
          <div>
            <p className="product-eyebrow">DATA TRANSFER</p>
            <h2>迁移我和这个角色的数据</h2>
            <p>
              导出当前账号的文字历史、会话摘要和长期记忆，再登录另一个账号并在对应角色中导入。
            </p>
            <small>
              文件包含私人内容，请妥善保管；不会包含账号、密码、模型密钥或旧服务的运行时凭据。
            </small>
          </div>
          <div className="relationship-transfer-actions">
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={onExportRelationship}
            >
              {busyAction === "export" ? "正在整理…" : "导出关系数据"}
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => importInput.current?.click()}
            >
              {busyAction === "import" ? "正在导入…" : "从文件导入"}
            </button>
            <input
              ref={importInput}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) onImportRelationship(file);
              }}
            />
          </div>
        </section>

        <div className="detail-grid">
          <section className="detail-card detail-persona">
            <p className="product-eyebrow">PERSONA</p>
            <h2>角色设定</h2>
            {usesCustomPrompt ? (
              <div className="detail-field">
                <h3>完整 Prompt</h3>
                <pre className="detail-custom-prompt">
                  {character.persona.customPrompt}
                </pre>
              </div>
            ) : (
              <>
                <DetailField
                  label="背景"
                  value={character.persona.background}
                />
                <DetailField
                  label="与我的关系"
                  value={character.persona.relationship}
                />
                <DetailField
                  label="说话方式"
                  value={character.persona.speakingStyle}
                />
                <DetailField
                  label="情绪风格"
                  value={character.persona.emotionalStyle}
                />
                <div className="detail-field">
                  <h3>性格</h3>
                  <div className="trait-list">
                    {character.persona.personalityTraits.map((trait) => (
                      <span key={trait}>{trait}</span>
                    ))}
                  </div>
                </div>
                <div className="detail-field">
                  <h3>对话目标</h3>
                  <ul>
                    {character.persona.conversationGoals.map((goal) => (
                      <li key={goal}>{goal}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </section>

          <div className="detail-side-stack">
            <section className="detail-card">
              <p className="product-eyebrow">CONVERSATION</p>
              <h2>对话方式</h2>
              <dl className="policy-list">
                <div>
                  <dt>接通后</dt>
                  <dd>
                    {policy.firstSpeaker === "assistant"
                      ? "角色先自然打招呼"
                      : "等待你先开口"}
                  </dd>
                </div>
                <div>
                  <dt>回复风格</dt>
                  <dd>{responseStyleLabels[policy.responseStyle]}</dd>
                </div>
                <div>
                  <dt>沉默时</dt>
                  <dd>
                    {policy.silenceFollowUp.enabled
                      ? `约 ${Math.round(policy.silenceFollowUp.delayMs / 1000)} 秒后关心一次`
                      : "安静等待"}
                  </dd>
                </div>
              </dl>
              {character.openingLine && (
                <blockquote>“{character.openingLine}”</blockquote>
              )}
            </section>

            <section className="detail-card">
              <p className="product-eyebrow">VOICE</p>
              <h2>声音</h2>
              <p className="voice-name">{character.voiceProfile.displayName}</p>
              <p>{formatVoiceStyle(character.voiceProfile.style)}</p>
              <small>{character.realtimeModelProfile.displayName}</small>
            </section>

            {!usesCustomPrompt && (
              <section className="detail-card">
                <p className="product-eyebrow">SAMPLE LINES</p>
                <h2>示例台词</h2>
                <ul className="sample-lines">
                  {character.persona.sampleLines.map((line) => (
                    <li key={line}>“{line}”</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-field">
      <h3>{label}</h3>
      <p>{value}</p>
    </div>
  );
}

const responseStyleLabels = {
  concise: "简短自然",
  adaptive: "根据语境调整",
  detailed: "详细分步",
} as const;

function formatVoiceStyle(style: Character["voiceProfile"]["style"]): string {
  const items = [
    style.pace &&
      `语速${{ slow: "舒缓", normal: "自然", fast: "轻快" }[style.pace]}`,
    style.energy &&
      `活力${{ low: "平静", medium: "适中", high: "充沛" }[style.energy]}`,
    style.warmth &&
      `温柔度${{ low: "克制", medium: "适中", high: "温暖" }[style.warmth]}`,
    style.emotionInstruction,
  ].filter(Boolean);
  return items.length ? items.join(" · ") : "自然、清晰的角色声音";
}
