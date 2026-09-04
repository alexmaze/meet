import type {
  ChildTeachingUnavailableReason,
  GuardianHistoryAccess,
} from "@meet/protocol";

import {
  teachingCallPresentation,
  type TeachingAvailability,
  type TeachingCallState,
} from "./teaching-state.js";

type TeachingCallControlsProps =
  | {
      phase: "precall";
      characterName: string;
      availability: TeachingAvailability | null;
      loading: boolean;
      loadError: boolean;
      temporary: boolean;
      guardianHistoryAccess: GuardianHistoryAccess;
      disabled?: boolean;
      onEnable: () => void;
      onChatOnly: () => void;
    }
  | {
      phase: "incall";
      state: TeachingCallState;
      actionPending?: "request" | "mute" | null;
      onRequest: () => void;
      onMute: () => void;
    };

export default function TeachingCallControls(props: TeachingCallControlsProps) {
  if (props.phase === "precall") {
    return <PrecallControls {...props} />;
  }
  const presentation = teachingCallPresentation(props.state);
  return (
    <section
      className={`teaching-call-status tone-${presentation.tone}`}
      aria-label="学习小支线状态"
    >
      <div role="status" aria-live="polite">
        <strong>{presentation.label}</strong>
        <span>{presentation.detail}</span>
      </div>
      {(presentation.showRequest || presentation.showMute) && (
        <div className="teaching-call-actions">
          {presentation.showRequest && (
            <button
              type="button"
              disabled={Boolean(props.actionPending)}
              onClick={props.onRequest}
            >
              {props.actionPending === "request" ? "正在准备…" : "现在来一个"}
            </button>
          )}
          {presentation.showMute && (
            <button
              type="button"
              disabled={Boolean(props.actionPending)}
              onClick={props.onMute}
            >
              {props.actionPending === "mute"
                ? "正在回到聊天…"
                : props.state.state === "active"
                  ? "跳过，本次只聊天"
                  : "本次只聊天"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function PrecallControls(
  props: Extract<TeachingCallControlsProps, { phase: "precall" }>,
) {
  if (props.loading) {
    return (
      <section className="teaching-precall-card" aria-label="学习小支线说明">
        <p role="status">正在确认这次有没有学习小支线…</p>
        <button type="button" disabled>
          正在读取
        </button>
      </section>
    );
  }

  if (props.temporary) {
    return (
      <section
        className="teaching-precall-card unavailable"
        aria-label="学习小支线说明"
      >
        <div>
          <strong>临时对话本次只聊天</strong>
          <p>
            临时对话不会启用学习小支线，也不会把这次内容写入长期记忆。
            你仍然可以和{props.characterName}正常聊天。
          </p>
        </div>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onChatOnly}
        >
          开始临时聊天
        </button>
      </section>
    );
  }

  if (!props.availability?.enabled) {
    return (
      <section
        className="teaching-precall-card unavailable"
        aria-label="学习小支线说明"
      >
        <div>
          <strong>学习小支线本次不可用</strong>
          <p>
            {props.loadError
              ? "暂时没能确认学习设置。为了不误用设置，这次会只聊天。"
              : unavailableReason(props.availability?.reason)}
            普通聊天不受影响。
          </p>
        </div>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onChatOnly}
        >
          开始普通聊天
        </button>
      </section>
    );
  }

  const subject = subjectLabels[props.availability.subject];
  const difficulty = difficultyLabels[props.availability.difficulty];
  return (
    <section className="teaching-precall-card" aria-label="学习小支线说明">
      <div>
        <p className="teaching-precall-eyebrow">开始前告诉你</p>
        <strong>
          和{props.characterName}聊天时，可以带一个{subject}小挑战
        </strong>
        <p>
          {props.characterName}是 AI 角色，这个学习目标由家庭里的成人设置。
          难度是“{difficulty}”。
          {props.availability.triggerMode === "gentle"
            ? `${props.characterName}只会在话题合适时轻轻邀请，不会连续出题。`
            : `只有你点“现在来一个”时才开始。`}
          你可以随时跳过，跳过后这次只聊天。
        </p>
        <p className="teaching-data-note">
          应用只记录这次是否已经说明、邀请、跳过或完成，不记录分数。
          {props.guardianHistoryAccess === "allowed"
            ? "家庭管理员可按你的账号设置查看这次保存的文字历史；模型服务仍只接收完成当前回应所需的信息。"
            : "这次保存的文字历史按你的账号隔离，家庭管理员不能读取；模型服务仍只接收完成当前回应所需的信息。"}
        </p>
      </div>
      <div className="teaching-precall-actions">
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onEnable}
        >
          知道了，开始聊天
        </button>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onChatOnly}
        >
          本次只聊天
        </button>
      </div>
    </section>
  );
}

const subjectLabels = {
  chinese: "语文",
  english: "英语",
  math: "数学",
  science: "科学",
  general: "综合/其他",
} as const;

const difficultyLabels = {
  starter: "轻松入门",
  growing: "逐步提升",
  challenge: "稍有挑战",
} as const;

function unavailableReason(
  reason: ChildTeachingUnavailableReason | undefined,
): string {
  switch (reason) {
    case "no_enabled_plan":
      return "这个角色还没有开启学习设置。";
    case "character_unavailable":
      return "这个角色当前不能使用学习设置。";
    case "provider_unsupported":
      return "当前实时语音服务还不支持学习小支线。";
    default:
      return "这次会只使用普通聊天。";
  }
}
