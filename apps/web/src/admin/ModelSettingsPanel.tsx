import type {
  ModelConnectionAdapter,
  ModelConnection,
  ModelProfile,
  ModelProfileKind,
  ModelPurpose,
  ModelSettingsResponse,
} from "@meet/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  createConnection,
  createModel,
  createVoice,
  deleteModel,
  getModelSettings,
  ModelSettingsApiError,
  setBinding,
  testModel,
  updateConnection,
  updateModel,
} from "./model-settings-api.js";

export default function ModelSettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      setSettings(await getModelSettings());
    } catch (value) {
      setError(message(value));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open) return null;

  const perform = async (
    key: string,
    action: () => Promise<void>,
    text: string,
  ) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(text);
      await reload();
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy("");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="model-settings-panel"
      aria-labelledby="model-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="admin-panel-header">
        <div>
          <p className="product-eyebrow">MODEL SETTINGS</p>
          <h2 id="model-settings-title">模型设置</h2>
          <p>先创建供应商连接，再添加、测试并启用模型。</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭模型设置">
          ×
        </button>
      </header>
      {error && (
        <div className="product-notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="product-notice success" role="status">
          {notice}
        </div>
      )}
      {loading && !settings ? (
        <p>正在读取模型配置…</p>
      ) : (
        settings && (
          <div className="model-settings-content">
            <ConnectionForm
              disabled={Boolean(busy)}
              onSubmit={(input) =>
                perform(
                  "connection",
                  () => createConnection(input),
                  "供应商连接已保存为待测试配置。",
                )
              }
            />
            <section className="model-settings-section">
              <h3>供应商连接</h3>
              {settings.connections.length === 0 ? (
                <p>还没有连接。</p>
              ) : (
                settings.connections.map((connection) => (
                  <ConnectionCard
                    key={connection.id}
                    connection={connection}
                    disabled={Boolean(busy)}
                    onSave={(input) =>
                      perform(
                        `connection-${connection.id}`,
                        () => updateConnection(connection.id, input),
                        "候选连接已保存；请重新测试关联模型后切换生效。",
                      )
                    }
                  />
                ))
              )}
            </section>
            <ModelForm
              connections={settings.connections}
              disabled={Boolean(busy)}
              onSubmit={(input) =>
                perform(
                  "model",
                  () => createModel(input),
                  "模型已添加，测试成功后可启用。",
                )
              }
            />
            <Bindings
              settings={settings}
              disabled={Boolean(busy)}
              onChange={(purpose, id) =>
                perform(
                  `binding-${purpose}`,
                  () => setBinding(purpose, id),
                  "默认用途已经更新。",
                )
              }
            />
            <ModelList settings={settings} busy={busy} perform={perform} />
            <p className="profile-privacy-note">
              API 密钥按已确认方案明文存入私有数据库，界面与 API
              永不回显；数据库或快照泄露会暴露密钥。
            </p>
          </div>
        )
      )}
    </dialog>
  );
}

function ConnectionCard({
  connection,
  disabled,
  onSave,
}: {
  connection: ModelConnection;
  disabled: boolean;
  onSave: (input: {
    revision: number;
    displayName: string;
    endpoint: string;
    apiKey?: string;
    compatibilityPreset?: "standard" | "dashscope";
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(connection.displayName);
  const [endpoint, setEndpoint] = useState(connection.endpoint);
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState<"standard" | "dashscope">(
    connection.compatibilityPreset ?? "standard",
  );
  if (!editing) {
    return (
      <article className="model-setting-card">
        <strong>{connection.displayName}</strong>
        <span>{adapterLabels[connection.adapter]}</span>
        <small>{connection.endpoint}</small>
        <small>
          {connection.hasCredential ? "密钥已配置（不可查看）" : "密钥未配置"} ·{" "}
          {statusLabels[connection.status]}
          {connection.hasPendingChanges ? " · 有候选修订待测试" : ""}
        </small>
        <div className="model-actions">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            编辑候选配置
          </button>
        </div>
      </article>
    );
  }
  return (
    <form
      className="model-setting-card"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          revision: connection.revision,
          displayName,
          endpoint,
          ...(apiKey ? { apiKey } : {}),
          ...(connection.adapter === "openai_chat_completions"
            ? { compatibilityPreset: preset }
            : {}),
        });
        setApiKey("");
        setEditing(false);
      }}
    >
      <strong>{adapterLabels[connection.adapter]}</strong>
      <label>
        显示名称
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label>
        端点 / Base URL
        <input
          required
          type="url"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </label>
      <label>
        新 API 密钥（留空保留）
        <input
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      {connection.adapter === "openai_chat_completions" && (
        <label>
          兼容预设
          <select
            value={preset}
            onChange={(event) =>
              setPreset(event.target.value as "standard" | "dashscope")
            }
          >
            <option value="standard">标准</option>
            <option value="dashscope">阿里百炼</option>
          </select>
        </label>
      )}
      <div className="model-actions">
        <button disabled={disabled}>保存候选修订</button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setEditing(false)}
        >
          取消
        </button>
      </div>
    </form>
  );
}

function ConnectionForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (input: {
    adapter: ModelConnectionAdapter;
    displayName: string;
    endpoint: string;
    apiKey: string;
    compatibilityPreset?: "standard" | "dashscope";
  }) => void;
}) {
  const [adapter, setAdapter] =
    useState<ModelConnectionAdapter>("qwen_realtime");
  const [displayName, setDisplayName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState<"standard" | "dashscope">("standard");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      adapter,
      displayName,
      endpoint,
      apiKey,
      ...(adapter === "openai_chat_completions"
        ? { compatibilityPreset: preset }
        : {}),
    });
  };
  return (
    <form className="settings-group model-settings-section" onSubmit={submit}>
      <h3>1. 新建供应商连接</h3>
      <label>
        协议
        <select
          value={adapter}
          onChange={(event) =>
            setAdapter(event.target.value as ModelConnectionAdapter)
          }
        >
          <option value="qwen_realtime">千问实时语音</option>
          <option value="doubao_realtime">豆包实时语音</option>
          <option value="openai_chat_completions">
            OpenAI-compatible 文本
          </option>
        </select>
      </label>
      <label>
        显示名称
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label>
        端点 / Base URL
        <input
          required
          type="url"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder="https://…"
        />
      </label>
      <label>
        API 密钥
        <input
          required
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      {adapter === "openai_chat_completions" && (
        <label>
          兼容预设
          <select
            value={preset}
            onChange={(event) =>
              setPreset(event.target.value as "standard" | "dashscope")
            }
          >
            <option value="standard">标准</option>
            <option value="dashscope">阿里百炼</option>
          </select>
        </label>
      )}
      <button disabled={disabled}>保存连接</button>
    </form>
  );
}

function ModelForm({
  connections,
  disabled,
  onSubmit,
}: {
  connections: ModelSettingsResponse["connections"];
  disabled: boolean;
  onSubmit: (input: {
    connectionId: string;
    kind: ModelProfileKind;
    model: string;
    displayName: string;
  }) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const connection = connections.find((item) => item.id === connectionId);
  const kind: ModelProfileKind =
    connection?.adapter === "openai_chat_completions"
      ? "text"
      : "realtime_voice";
  return (
    <form
      className="settings-group model-settings-section"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ connectionId, kind, model, displayName });
      }}
    >
      <h3>2. 添加模型</h3>
      <label>
        连接
        <select
          required
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
        >
          <option value="">请选择</option>
          {connections.map((item) => (
            <option value={item.id} key={item.id}>
              {item.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        模型 ID
        <input
          required
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <label>
        显示名称
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <button disabled={disabled || !connectionId}>添加模型</button>
    </form>
  );
}

function Bindings({
  settings,
  disabled,
  onChange,
}: {
  settings: ModelSettingsResponse;
  disabled: boolean;
  onChange: (purpose: ModelPurpose, id: string) => void;
}) {
  return (
    <section className="model-settings-section">
      <h3>3. 默认与文本用途</h3>
      <p>
        等待配置任务：{settings.work.waiting} · 失败：{settings.work.failed}
      </p>
      {(
        [
          "realtime_default",
          "conversation_summary",
          "memory_extraction",
        ] as const
      ).map((purpose) => {
        const kind = purpose === "realtime_default" ? "realtime_voice" : "text";
        const binding = settings.bindings.find(
          (item) => item.purpose === purpose,
        );
        return (
          <label key={purpose}>
            {purposeLabels[purpose]}
            <select
              disabled={disabled}
              value={binding?.modelProfileId ?? ""}
              onChange={(event) =>
                event.target.value && onChange(purpose, event.target.value)
              }
            >
              <option value="">尚未设置</option>
              {settings.models
                .filter(
                  (model) => model.kind === kind && model.status === "enabled",
                )
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
    </section>
  );
}

function ModelList({
  settings,
  busy,
  perform,
}: {
  settings: ModelSettingsResponse;
  busy: string;
  perform: (
    key: string,
    action: () => Promise<void>,
    notice: string,
  ) => Promise<void>;
}) {
  return (
    <section className="model-settings-section">
      <h3>4. 模型与音色</h3>
      {(["realtime_voice", "text"] as const).map((kind) => (
        <div key={kind}>
          <h4>{kind === "realtime_voice" ? "实时语音模型" : "文本模型"}</h4>
          {settings.models
            .filter((model) => model.kind === kind)
            .map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                settings={settings}
                busy={busy}
                perform={perform}
              />
            ))}
        </div>
      ))}
    </section>
  );
}

function ModelCard({
  model,
  settings,
  busy,
  perform,
}: {
  model: ModelProfile;
  settings: ModelSettingsResponse;
  busy: string;
  perform: (
    key: string,
    action: () => Promise<void>,
    notice: string,
  ) => Promise<void>;
}) {
  const voices = settings.voices.filter(
    (voice) => voice.modelProfileId === model.id,
  );
  const [testVoiceId, setTestVoiceId] = useState(voices[0]?.id ?? "");
  const [voiceId, setVoiceId] = useState("");
  const [voiceName, setVoiceName] = useState("");
  return (
    <article className="model-setting-card">
      <strong>{model.displayName}</strong>
      <span>{model.model}</span>
      <small>
        {statusLabels[model.status]} · 角色 {model.characterReferenceCount} ·
        用途 {model.purposeReferenceCount} · 待执行任务{" "}
        {model.queuedReferenceCount} · {model.verifiedAt ? "已验证" : "未验证"}
      </small>
      {!model.connectionId && (
        <small>
          升级保留的模型尚未连接。请在“添加模型”中选择对应连接并填写相同模型
          ID，系统会保留角色引用并重新挂接。
        </small>
      )}
      {model.kind === "realtime_voice" && (
        <>
          <label>
            测试音色
            <select
              value={testVoiceId}
              onChange={(event) => setTestVoiceId(event.target.value)}
            >
              {voices.map((voice) => (
                <option value={voice.id} key={voice.id}>
                  {voice.displayName}（{voice.providerVoiceId}）
                </option>
              ))}
            </select>
          </label>
          <div className="model-inline-fields">
            <input
              placeholder="新音色 ID"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            />
            <input
              placeholder="显示名"
              value={voiceName}
              onChange={(event) => setVoiceName(event.target.value)}
            />
            <button
              type="button"
              disabled={
                !model.connectionId || !voiceId || !voiceName || Boolean(busy)
              }
              onClick={() =>
                void perform(
                  `voice-${model.id}`,
                  () =>
                    createVoice(model.id, {
                      providerVoiceId: voiceId,
                      displayName: voiceName,
                    }),
                  "自定义音色已添加，请测试后使用。",
                )
              }
            >
              添加音色
            </button>
          </div>
        </>
      )}
      <div className="model-actions">
        <button
          type="button"
          disabled={
            !model.connectionId ||
            Boolean(busy) ||
            (model.kind === "realtime_voice" && !testVoiceId)
          }
          onClick={() =>
            void perform(
              `test-${model.id}`,
              () => testModel(model.id, testVoiceId || undefined),
              "连接测试成功。",
            )
          }
        >
          测试连接
        </button>
        {model.status !== "enabled" && (
          <button
            type="button"
            disabled={Boolean(busy) || !model.verifiedAt}
            onClick={() =>
              void perform(
                `enable-${model.id}`,
                () =>
                  updateModel(model.id, {
                    revision: model.revision,
                    status: "enabled",
                  }),
                "模型已启用。",
              )
            }
          >
            启用
          </button>
        )}
        {model.status === "enabled" && (
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void perform(
                `disable-${model.id}`,
                () =>
                  updateModel(model.id, {
                    revision: model.revision,
                    status: "disabled",
                  }),
                `模型已停用；${model.characterReferenceCount} 个角色、${model.purposeReferenceCount} 个用途不会自动迁移。`,
              )
            }
          >
            停用
          </button>
        )}
        {model.status === "draft" && model.referenceCount === 0 && (
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void perform(
                `delete-${model.id}`,
                () => deleteModel(model.id),
                "草稿模型已删除。",
              )
            }
          >
            删除
          </button>
        )}
      </div>
    </article>
  );
}

function message(value: unknown) {
  return value instanceof ModelSettingsApiError || value instanceof Error
    ? value.message
    : "模型设置操作失败。";
}
const adapterLabels: Record<ModelConnectionAdapter, string> = {
  qwen_realtime: "千问实时语音",
  doubao_realtime: "豆包实时语音",
  openai_chat_completions: "OpenAI-compatible 文本",
};
const statusLabels = {
  draft: "草稿",
  enabled: "已启用",
  disabled: "已停用",
} as const;
const purposeLabels: Record<ModelPurpose, string> = {
  realtime_default: "新角色默认实时模型",
  conversation_summary: "会话摘要模型",
  memory_extraction: "长期记忆提取模型",
};
