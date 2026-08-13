import type { CharacterSummary, UserAccount } from "@meet/protocol";
import type { CSSProperties } from "react";

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
}: CharacterLibraryProps) {
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

      <section
        className="library-section"
        aria-labelledby="character-list-title"
      >
        <div className="section-title-row">
          <div>
            <p className="product-eyebrow">YOUR CAST</p>
            <h2 id="character-list-title">角色</h2>
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
            {characters.map((character) => (
              <CharacterCard
                key={character.id}
                character={character}
                callPending={busyCharacterId === character.id}
                onOpen={() => onOpen(character.id)}
                onCall={() => onCall(character.id)}
              />
            ))}
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
};

function CharacterCard({
  character,
  callPending,
  onOpen,
  onCall,
}: CharacterCardProps) {
  return (
    <article
      className={`character-card character-bg-${character.visualProfile.background}`}
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
          <span className="character-card-meta">
            <VisibilityBadge visibility={character.visibility} />
            {character.systemKey && <span className="preset-badge">预置</span>}
          </span>
          <strong>{character.name}</strong>
          <span className="character-description">{character.description}</span>
          <span className="character-voice">
            声音 · {character.voiceProfile.displayName}
          </span>
        </span>
      </button>
      <div className="character-card-footer">
        <button
          className="character-detail-link"
          type="button"
          onClick={onOpen}
        >
          了解角色 <span aria-hidden="true">→</span>
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
              : "通话"}
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
