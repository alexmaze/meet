import type { ConversationContinuityStatus } from "@meet/protocol";
import { analysisStateLabel } from "./continuity-presentation.js";

export type MemoryLocation = {
  characterId: string;
  sourceConversationId?: string;
  status?: "active" | "suggested";
};

export default function ConversationReview({
  status,
  onViewMemories,
}: {
  status: ConversationContinuityStatus;
  onViewMemories?: (location: MemoryLocation) => void;
}) {
  const temporary = status.conversation.mode === "temporary";
  return (
    <section className="continuity-review" aria-label="本次通话回顾">
      <div>
        <h2>本次回顾</h2>
        {status.summary.state === "completed" && status.summary.content ? (
          <p className="continuity-review-content">{status.summary.content}</p>
        ) : (
          <p>{analysisStateLabel(status.summary.state, "summary")}</p>
        )}
      </div>
      <div>
        <h3>长期记忆</h3>
        {temporary ? (
          <p>临时对话不新增长期记忆。</p>
        ) : status.memory.state === "completed" ? (
          <>
            <p>
              {status.memory.activeCount + status.memory.suggestedCount === 0
                ? "本次没有新增需要长期记住的内容"
                : `新保存 ${status.memory.activeCount} 条 · 待确认 ${status.memory.suggestedCount} 条`}
            </p>
            {status.isOwner &&
              onViewMemories &&
              status.memory.activeCount + status.memory.suggestedCount > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    onViewMemories({
                      characterId: status.conversation.character.id,
                      sourceConversationId: status.conversation.id,
                    })
                  }
                >
                  查看本次记忆
                </button>
              )}
          </>
        ) : (
          <p>{analysisStateLabel(status.memory.state, "memory")}</p>
        )}
      </div>
    </section>
  );
}
