import type { Character, UserAccount } from "@meet/protocol";
import type { CSSProperties } from "react";

import { getCharacterActionVisibility } from "./character-logic.js";
import { VisibilityBadge } from "./CharacterLibrary.js";

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
}: CharacterDetailProps) {
  const actions = getCharacterActionVisibility(user, character.permissions);
  const policy = character.conversationPolicy;

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
              disabled={busyAction === "call"}
              onClick={onCall}
            >
              <span aria-hidden="true">●</span>
              {busyAction === "call" ? "正在准备…" : `和${character.name}通话`}
            </button>
            <span className="detail-voice">
              {character.voiceProfile.displayName}
            </span>
          </div>
        </div>
      </section>

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

      <div className="detail-grid">
        <section className="detail-card detail-persona">
          <p className="product-eyebrow">PERSONA</p>
          <h2>角色设定</h2>
          <DetailField label="背景" value={character.persona.background} />
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
            <small>{character.providerProfile.displayName}</small>
          </section>

          <section className="detail-card">
            <p className="product-eyebrow">SAMPLE LINES</p>
            <h2>示例台词</h2>
            <ul className="sample-lines">
              {character.persona.sampleLines.map((line) => (
                <li key={line}>“{line}”</li>
              ))}
            </ul>
          </section>
        </div>
      </div>
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
