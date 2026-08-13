import {
  CHARACTER_AVATAR_MAX_BYTES,
  type Character,
  type CreateCharacterRequest,
  type RealtimeModelProfile,
  type UserAccount,
  type VoiceProfile,
} from "@meet/protocol";
import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { previewVoice, uploadCharacterAvatar } from "./character-api.js";
import {
  buildCreateCharacterRequest,
  builtInAvatarChoices,
  characterToForm,
  createEmptyCharacterForm,
  type CharacterFormValue,
} from "./character-logic.js";

type CharacterEditorProps = {
  user: UserAccount;
  character: Character | null;
  providers: RealtimeModelProfile[];
  voices: VoiceProfile[];
  realtimeDefaultModelProfileId: string | null;
  saving: boolean;
  serverError: string;
  onCancel: () => void;
  onSave: (request: CreateCharacterRequest) => void;
};

type VoicePreviewState =
  | { status: "idle" }
  | { status: "loading"; voiceProfileId: string }
  | {
      status: "ready" | "playing";
      voiceProfileId: string;
      objectUrl: string;
    }
  | { status: "error"; voiceProfileId: string; message: string };

type AvatarUploadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

const avatarContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export default function CharacterEditor({
  user,
  character,
  providers,
  voices,
  realtimeDefaultModelProfileId,
  saving,
  serverError,
  onCancel,
  onSave,
}: CharacterEditorProps) {
  const [form, setForm] = useState<CharacterFormValue>(() =>
    character
      ? characterToForm(character)
      : createEmptyCharacterForm(
          providers,
          voices,
          realtimeDefaultModelProfileId,
        ),
  );
  const [validationError, setValidationError] = useState("");
  const [voicePreview, setVoicePreview] = useState<VoicePreviewState>({
    status: "idle",
  });
  const [avatarUpload, setAvatarUpload] = useState<AvatarUploadState>({
    status: "idle",
  });
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const avatarAbortRef = useRef<AbortController | null>(null);
  const matchingVoices = useMemo(
    () =>
      voices.filter(
        (voice) => voice.realtimeModelProfileId === form.providerProfileId,
      ),
    [form.providerProfileId, voices],
  );

  useEffect(
    () => () => {
      previewAbortRef.current?.abort();
      avatarAbortRef.current?.abort();
      previewAudioRef.current?.pause();
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
      }
    },
    [],
  );

  const resetVoicePreview = () => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    setVoicePreview({ status: "idle" });
  };

  const toggleVoicePreview = async () => {
    const voiceProfileId = form.voiceProfileId;
    if (!voiceProfileId) return;

    if (
      voicePreview.status === "playing" &&
      voicePreview.voiceProfileId === voiceProfileId
    ) {
      previewAudioRef.current?.pause();
      setVoicePreview({ ...voicePreview, status: "ready" });
      return;
    }
    if (
      voicePreview.status === "ready" &&
      voicePreview.voiceProfileId === voiceProfileId
    ) {
      try {
        await previewAudioRef.current?.play();
      } catch {
        // 下方原生播放器仍可用于满足更严格的移动端播放策略。
      }
      return;
    }

    resetVoicePreview();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setVoicePreview({ status: "loading", voiceProfileId });
    try {
      const blob = await previewVoice(voiceProfileId, controller.signal);
      if (controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      previewObjectUrlRef.current = objectUrl;
      setVoicePreview({ status: "ready", voiceProfileId, objectUrl });
    } catch (error) {
      if (controller.signal.aborted) return;
      setVoicePreview({
        status: "error",
        voiceProfileId,
        message:
          error instanceof Error
            ? "暂时无法生成试听，请检查实时服务配置后重试。"
            : "暂时无法生成试听，请稍后重试。",
      });
    } finally {
      if (previewAbortRef.current === controller) {
        previewAbortRef.current = null;
      }
    }
  };

  const change = <K extends keyof CharacterFormValue>(
    key: K,
    value: CharacterFormValue[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setValidationError("");
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = buildCreateCharacterRequest(form);
    if (!result.ok) {
      setValidationError(result.message);
      return;
    }
    onSave(result.value);
  };

  const chooseAvatar = (choice: (typeof builtInAvatarChoices)[number]) => {
    avatarAbortRef.current?.abort();
    avatarAbortRef.current = null;
    setAvatarUpload({ status: "idle" });
    setForm((current) => ({
      ...current,
      avatarUrl: choice.value,
      accentColor: choice.accentColor,
      visualBackground: choice.background,
    }));
  };

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (
      !avatarContentTypes.has(file.type) ||
      file.size === 0 ||
      file.size > CHARACTER_AVATAR_MAX_BYTES
    ) {
      setAvatarUpload({
        status: "error",
        message: "请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片。",
      });
      input.value = "";
      return;
    }

    avatarAbortRef.current?.abort();
    const controller = new AbortController();
    avatarAbortRef.current = controller;
    setAvatarUpload({ status: "loading" });
    try {
      const uploaded = await uploadCharacterAvatar(file, controller.signal);
      if (controller.signal.aborted) return;
      setForm((current) => ({
        ...current,
        avatarUrl: uploaded.avatarUrl,
      }));
      setAvatarUpload({ status: "idle" });
      setValidationError("");
    } catch {
      if (controller.signal.aborted) return;
      setAvatarUpload({
        status: "error",
        message: "形象上传失败，请检查图片后重试。",
      });
    } finally {
      if (avatarAbortRef.current === controller) {
        avatarAbortRef.current = null;
      }
      input.value = "";
    }
  };

  return (
    <div className="editor-page page-frame">
      <button className="back-button" type="button" onClick={onCancel}>
        ← 取消
      </button>
      <header className="editor-heading">
        <div>
          <p className="product-eyebrow">STRUCTURED CHARACTER CARD</p>
          <h1>{character ? `编辑 ${character.name}` : "创建角色"}</h1>
          <p>
            默认只需填写角色名称；选择完整 Prompt 高级模式后，再填写一段角色
            Prompt。
          </p>
        </div>
        <span className="editor-owner-note">
          {user.accountType === "admin"
            ? "管理员创建后默认全家共享"
            : "新角色默认仅自己可见"}
        </span>
      </header>

      {character && character.visibility !== "private" && (
        <div className="product-notice warning" role="status">
          这是家庭共享角色。修改人设或声音后，会影响全家之后发起的通话。
        </div>
      )}
      {(validationError || serverError) && (
        <div className="product-notice error" role="alert">
          {validationError || serverError}
        </div>
      )}

      <form className="character-form" onSubmit={submit} aria-busy={saving}>
        <fieldset disabled={saving}>
          <EditorSection
            eyebrow="IDENTITY"
            title="角色身份"
            description="先给角色一个清楚、容易记住的轮廓。"
          >
            <div className="form-grid two-columns">
              <Field label="角色名称" htmlFor="character-name" required>
                <input
                  id="character-name"
                  maxLength={80}
                  aria-required="true"
                  value={form.name}
                  onChange={(event) => change("name", event.target.value)}
                />
              </Field>
              <Field
                label="一句话简介"
                htmlFor="character-description"
                optional
              >
                <input
                  id="character-description"
                  maxLength={600}
                  value={form.description}
                  onChange={(event) =>
                    change("description", event.target.value)
                  }
                />
              </Field>
            </div>
            <Field label="人设编辑方式" htmlFor="character-persona-mode">
              <select
                id="character-persona-mode"
                value={form.personaMode}
                onChange={(event) =>
                  change(
                    "personaMode",
                    event.target.value as CharacterFormValue["personaMode"],
                  )
                }
              >
                <option value="structured">结构化编辑</option>
                <option value="custom_prompt">完整 Prompt（高级）</option>
              </select>
            </Field>
            {form.personaMode === "structured" && (
              <>
                <Field label="人物背景" htmlFor="character-background" optional>
                  <textarea
                    id="character-background"
                    rows={4}
                    maxLength={4000}
                    value={form.background}
                    onChange={(event) =>
                      change("background", event.target.value)
                    }
                  />
                </Field>
                <div className="form-grid two-columns">
                  <Field
                    label="性格特点（每行一项）"
                    htmlFor="character-traits"
                    optional
                  >
                    <textarea
                      id="character-traits"
                      rows={4}
                      value={form.personalityTraits}
                      onChange={(event) =>
                        change("personalityTraits", event.target.value)
                      }
                    />
                  </Field>
                  <Field
                    label="与用户的关系"
                    htmlFor="character-relationship"
                    optional
                  >
                    <textarea
                      id="character-relationship"
                      rows={4}
                      maxLength={1000}
                      value={form.relationship}
                      onChange={(event) =>
                        change("relationship", event.target.value)
                      }
                    />
                  </Field>
                </div>
              </>
            )}
          </EditorSection>

          {form.personaMode === "custom_prompt" && (
            <EditorSection
              eyebrow="ADVANCED PROMPT"
              title="完整角色 Prompt"
              description="这段文本会直接取代结构化的人物背景、性格、关系、表达方式、目标和示例台词。"
            >
              <Field
                label="角色 Prompt"
                htmlFor="character-custom-prompt"
                required
              >
                <textarea
                  id="character-custom-prompt"
                  className="custom-prompt-editor"
                  rows={18}
                  maxLength={12000}
                  aria-required="true"
                  placeholder="直接写入完整的人设与行为指令，例如：你是……你与用户的关系是……回答时……"
                  value={form.customPrompt}
                  onChange={(event) =>
                    change("customPrompt", event.target.value)
                  }
                />
              </Field>
              <p className="field-help">
                角色名称仍用于列表显示；开场、沉默追问、声音和形象继续作为独立运行配置保存。
              </p>
            </EditorSection>
          )}

          {form.personaMode === "structured" && (
            <EditorSection
              eyebrow="EXPRESSION"
              title="表达方式"
              description="决定角色怎么说、为什么说，以及说话时带着怎样的情绪。"
            >
              <div className="form-grid two-columns">
                <Field
                  label="说话习惯"
                  htmlFor="character-speaking-style"
                  optional
                >
                  <textarea
                    id="character-speaking-style"
                    rows={4}
                    maxLength={1000}
                    value={form.speakingStyle}
                    onChange={(event) =>
                      change("speakingStyle", event.target.value)
                    }
                  />
                </Field>
                <Field
                  label="情绪风格"
                  htmlFor="character-emotional-style"
                  optional
                >
                  <textarea
                    id="character-emotional-style"
                    rows={4}
                    maxLength={1000}
                    value={form.emotionalStyle}
                    onChange={(event) =>
                      change("emotionalStyle", event.target.value)
                    }
                  />
                </Field>
                <Field
                  label="对话目标（每行一项）"
                  htmlFor="character-goals"
                  optional
                >
                  <textarea
                    id="character-goals"
                    rows={5}
                    value={form.conversationGoals}
                    onChange={(event) =>
                      change("conversationGoals", event.target.value)
                    }
                  />
                </Field>
                <Field
                  label="示例台词（每行一句）"
                  htmlFor="character-samples"
                  optional
                >
                  <textarea
                    id="character-samples"
                    rows={5}
                    value={form.sampleLines}
                    onChange={(event) =>
                      change("sampleLines", event.target.value)
                    }
                  />
                </Field>
              </div>
              <details className="advanced-fields">
                <summary>高级角色提示</summary>
                <Field label="补充指令（选填）" htmlFor="character-advanced">
                  <textarea
                    id="character-advanced"
                    rows={5}
                    maxLength={4000}
                    value={form.advancedInstructions}
                    onChange={(event) =>
                      change("advancedInstructions", event.target.value)
                    }
                  />
                </Field>
              </details>
            </EditorSection>
          )}

          <EditorSection
            eyebrow="CONVERSATION"
            title="开场与回复"
            description="这些策略单独保存，不会藏在不可解释的提示词里。"
          >
            <Field label="自然开场白（选填）" htmlFor="character-opening">
              <textarea
                id="character-opening"
                rows={3}
                maxLength={500}
                value={form.openingLine}
                onChange={(event) => change("openingLine", event.target.value)}
              />
            </Field>
            <div className="form-grid three-columns">
              <Field label="接通后谁先说" htmlFor="character-first-speaker">
                <select
                  id="character-first-speaker"
                  value={form.firstSpeaker}
                  onChange={(event) =>
                    change(
                      "firstSpeaker",
                      event.target.value as CharacterFormValue["firstSpeaker"],
                    )
                  }
                >
                  <option value="assistant">角色先打招呼</option>
                  <option value="user">等待用户开口</option>
                </select>
              </Field>
              <Field label="默认回复风格" htmlFor="character-response-style">
                <select
                  id="character-response-style"
                  value={form.responseStyle}
                  onChange={(event) =>
                    change(
                      "responseStyle",
                      event.target.value as CharacterFormValue["responseStyle"],
                    )
                  }
                >
                  <option value="concise">简短自然</option>
                  <option value="adaptive">根据语境调整</option>
                  <option value="detailed">详细分步</option>
                </select>
              </Field>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.silenceFollowUpEnabled}
                  onChange={(event) =>
                    change("silenceFollowUpEnabled", event.target.checked)
                  }
                />
                <span>
                  <strong>沉默时关心一次</strong>
                  <small>约 12 秒后自然追问，之后安静等待</small>
                </span>
              </label>
            </div>
          </EditorSection>

          <EditorSection
            eyebrow="VOICE & LOOK"
            title="声音与形象"
            description="角色声音固定保存，共享角色在全家账号中保持一致。"
          >
            <div className="form-grid two-columns">
              <Field label="实时能力" htmlFor="character-provider">
                <select
                  id="character-provider"
                  value={form.providerProfileId}
                  onChange={(event) => {
                    resetVoicePreview();
                    const providerProfileId = event.target.value;
                    const voice = voices.find(
                      (candidate) =>
                        candidate.realtimeModelProfileId === providerProfileId,
                    );
                    setForm((current) => ({
                      ...current,
                      providerProfileId,
                      voiceProfileId: voice?.id ?? "",
                    }));
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="voice-picker-field">
                <Field label="角色声音" htmlFor="character-voice">
                  <select
                    id="character-voice"
                    value={form.voiceProfileId}
                    onChange={(event) => {
                      resetVoicePreview();
                      change("voiceProfileId", event.target.value);
                    }}
                  >
                    {matchingVoices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="voice-preview-row">
                  <button
                    className="secondary-button voice-preview-button"
                    type="button"
                    disabled={
                      !form.voiceProfileId || voicePreview.status === "loading"
                    }
                    onClick={() => void toggleVoicePreview()}
                  >
                    {voicePreview.status === "loading"
                      ? "正在生成试听…"
                      : voicePreview.status === "playing"
                        ? "停止试听"
                        : voicePreview.status === "ready" &&
                            voicePreview.voiceProfileId === form.voiceProfileId
                          ? "播放试听"
                          : "试听声音"}
                  </button>
                  <span className="voice-preview-note" aria-live="polite">
                    {voicePreview.status === "error"
                      ? voicePreview.message
                      : "固定短句 · 不会创建对话记录"}
                  </span>
                </div>
                {(voicePreview.status === "ready" ||
                  voicePreview.status === "playing") &&
                  voicePreview.voiceProfileId === form.voiceProfileId && (
                    <audio
                      className="voice-preview-audio"
                      autoPlay
                      controls
                      src={voicePreview.objectUrl}
                      onPlay={() =>
                        setVoicePreview({ ...voicePreview, status: "playing" })
                      }
                      onPause={() => {
                        if (!previewAudioRef.current?.ended) {
                          setVoicePreview({ ...voicePreview, status: "ready" });
                        }
                      }}
                      onEnded={() =>
                        setVoicePreview({ ...voicePreview, status: "ready" })
                      }
                      onError={() =>
                        setVoicePreview({
                          status: "error",
                          voiceProfileId: voicePreview.voiceProfileId,
                          message: "试听音频无法播放，请稍后重试。",
                        })
                      }
                      ref={(element) => {
                        if (element) previewAudioRef.current = element;
                      }}
                    />
                  )}
              </div>
            </div>
            <fieldset className="avatar-picker">
              <legend>内置形象</legend>
              <div className="avatar-choice-grid">
                {builtInAvatarChoices.map((choice) => (
                  <button
                    key={choice.value}
                    className={
                      form.avatarUrl === choice.value ? "selected" : ""
                    }
                    type="button"
                    aria-pressed={form.avatarUrl === choice.value}
                    onClick={() => chooseAvatar(choice)}
                  >
                    <img src={choice.value} alt="" />
                    <span>{choice.label}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="avatar-upload-panel">
              <img src={form.avatarUrl} alt="当前角色形象预览" />
              <div>
                <strong>上传自定义形象</strong>
                <p>支持 JPG、PNG、WebP，最大 5 MB。</p>
                <label
                  className={`secondary-button avatar-upload-button${
                    avatarUpload.status === "loading" ? " disabled" : ""
                  }`}
                >
                  {avatarUpload.status === "loading" ? "正在上传…" : "选择图片"}
                  <input
                    className="avatar-upload-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={saving || avatarUpload.status === "loading"}
                    onChange={(event) => void uploadAvatar(event)}
                  />
                </label>
                <span className="avatar-upload-status" aria-live="polite">
                  {avatarUpload.status === "error"
                    ? avatarUpload.message
                    : form.avatarUrl.startsWith("/api/media/")
                      ? "已使用上传的形象"
                      : "当前使用内置形象"}
                </span>
              </div>
            </div>
          </EditorSection>

          <div className="editor-submit-row">
            <button
              className="secondary-button"
              type="button"
              onClick={onCancel}
            >
              取消
            </button>
            <button
              className="product-primary-button"
              type="submit"
              disabled={saving || avatarUpload.status === "loading"}
            >
              {saving ? "正在保存…" : character ? "保存角色" : "创建角色"}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

function EditorSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="editor-section">
      <header>
        <p className="product-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="editor-section-fields">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  required = false,
  optional = false,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="character-field" htmlFor={htmlFor}>
      <span>
        {label}
        {required ? "（必填）" : optional ? "（选填）" : ""}
      </span>
      {children}
    </label>
  );
}
