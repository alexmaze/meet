import {
  BUILTIN_EMBEDDING_MODELS,
  type ModelConnectionAdapter,
  type ModelConnection,
  type ModelProfile,
  type ModelProfileKind,
  type ModelPurpose,
  type ModelSettingsResponse,
} from "@meet/protocol";

type BuiltinEmbeddingModelId = (typeof BUILTIN_EMBEDDING_MODELS)[number]["id"];
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

type SettingsTab = "overview" | "connections" | "models";

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
  const [activeTab, setActiveTab] = useState<SettingsTab>("overview");

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
    setActiveTab("overview");
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
        <button
          className="ui-icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭模型设置"
        >
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
            <nav
              className="settings-tabs"
              role="tablist"
              aria-label="模型设置分区"
            >
              {(
                [
                  ["overview", "概览与用途"],
                  ["connections", "供应商连接"],
                  ["models", "模型与音色"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`model-settings-tab-${id}`}
                  className={activeTab === id ? "active" : ""}
                  aria-selected={activeTab === id}
                  aria-controls="model-settings-tab-panel"
                  onClick={() => setActiveTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div
              id="model-settings-tab-panel"
              className="model-settings-tab-panel"
              role="tabpanel"
              aria-labelledby={`model-settings-tab-${activeTab}`}
            >
              {activeTab === "overview" && (
                <>
                  <section className="settings-overview">
                    <div>
                      <span>供应商连接</span>
                      <strong>{settings.connections.length}</strong>
                      <small>用于安全保存端点与密钥</small>
                    </div>
                    <div>
                      <span>已启用模型</span>
                      <strong>
                        {
                          settings.models.filter(
                            (model) => model.status === "enabled",
                          ).length
                        }
                      </strong>
                      <small>角色和后台任务可正常使用</small>
                    </div>
                    <div>
                      <span>等待配置任务</span>
                      <strong>{settings.work.waiting}</strong>
                      <small>补齐文本用途后会自动继续</small>
                    </div>
                    <div>
                      <span>记忆语义索引</span>
                      <strong>
                        {settings.bindings.find(
                          (binding) => binding.purpose === "memory_embedding",
                        )?.modelProfileId
                          ? "已配置"
                          : "未配置"}
                      </strong>
                      <small>由内置 Mem0 与当前 PostgreSQL 承载</small>
                    </div>
                  </section>
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
                  <section className="model-settings-section settings-guide">
                    <h3>推荐配置顺序</h3>
                    <ol>
                      <li>添加供应商连接并保存端点与密钥</li>
                      <li>添加模型，使用一个可用音色完成真实测试</li>
                      <li>
                        启用模型，再回到这里设置实时、摘要、提取与向量化用途
                      </li>
                    </ol>
                  </section>
                  <p className="profile-privacy-note settings-security-note">
                    API 密钥按已确认方案明文存入私有数据库，界面与 API
                    永不回显；数据库或快照泄露会暴露密钥。
                  </p>
                </>
              )}

              {activeTab === "connections" && (
                <div className="settings-tab-grid">
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
                  <section className="model-settings-section settings-existing-list">
                    <header>
                      <div>
                        <h3>已有连接</h3>
                        <p>修改后先保存为候选配置，测试成功才会正式生效。</p>
                      </div>
                      <span>{settings.connections.length}</span>
                    </header>
                    {settings.connections.length === 0 ? (
                      <div className="settings-empty-state">
                        还没有连接，请先完成左侧表单。
                      </div>
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
                </div>
              )}

              {activeTab === "models" && (
                <div className="settings-tab-grid models-tab-grid">
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
                  <ModelList
                    settings={settings}
                    busy={busy}
                    perform={perform}
                  />
                </div>
              )}
            </div>
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
    endpoint?: string;
    apiKey?: string;
    compatibilityPreset?: "standard" | "dashscope";
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(connection.displayName);
  const [endpoint, setEndpoint] = useState(connection.endpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState<"standard" | "dashscope">(
    connection.compatibilityPreset ?? "standard",
  );
  if (!editing) {
    return (
      <article className="model-setting-card">
        <strong>{connection.displayName}</strong>
        <span>{adapterLabels[connection.adapter]}</span>
        {connection.endpoint && <small>{connection.endpoint}</small>}
        <small>
          {connection.adapter === "builtin_fastembed"
            ? "本地加载 · 无需密钥"
            : connection.hasCredential
              ? "密钥已配置（不可查看）"
              : "密钥未配置"}{" "}
          · {statusLabels[connection.status]}
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
          ...(connection.adapter === "builtin_fastembed"
            ? {}
            : { endpoint, ...(apiKey ? { apiKey } : {}) }),
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
      {connection.adapter !== "builtin_fastembed" && (
        <>
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
        </>
      )}
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
    endpoint?: string;
    apiKey?: string;
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
      ...(adapter === "builtin_fastembed" ? {} : { endpoint, apiKey }),
      ...(adapter === "openai_chat_completions"
        ? { compatibilityPreset: preset }
        : {}),
    });
  };
  return (
    <form className="settings-group model-settings-section" onSubmit={submit}>
      <h3>添加新连接</h3>
      <p>可选择进程内本地模型，或填写外部服务的端点与密钥。</p>
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
          <option value="openai_embeddings">OpenAI-compatible Embedding</option>
          <option value="builtin_fastembed">内置本地 Embedding</option>
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
      {adapter !== "builtin_fastembed" ? (
        <>
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
        </>
      ) : (
        <p className="profile-privacy-note">
          模型只在服务端本地加载。首次测试会下载模型文件，无需 URL 或 API 密钥。
        </p>
      )}
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
    embeddingDimensions?: number;
  }) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(1536);
  const connection = connections.find((item) => item.id === connectionId);
  const builtin = connection?.adapter === "builtin_fastembed";
  const [builtinModelId, setBuiltinModelId] = useState<BuiltinEmbeddingModelId>(
    BUILTIN_EMBEDDING_MODELS.find(({ recommended }) => recommended)?.id ??
      BUILTIN_EMBEDDING_MODELS[0].id,
  );
  const builtinModel =
    BUILTIN_EMBEDDING_MODELS.find(({ id }) => id === builtinModelId) ??
    BUILTIN_EMBEDDING_MODELS[0];
  const kind: ModelProfileKind =
    connection?.adapter === "openai_chat_completions"
      ? "text"
      : connection?.adapter === "openai_embeddings" || builtin
        ? "embedding"
        : "realtime_voice";
  return (
    <form
      className="settings-group model-settings-section"
      onSubmit={(event) => {
        event.preventDefault();
        const selectedModel = builtin ? builtinModel.id : model;
        const selectedDimensions = builtin
          ? builtinModel.dimensions
          : embeddingDimensions;
        onSubmit({
          connectionId,
          kind,
          model: selectedModel,
          displayName,
          ...(kind === "embedding"
            ? { embeddingDimensions: selectedDimensions }
            : {}),
        });
      }}
    >
      <h3>添加模型</h3>
      <p>模型会挂在已有连接下，保存后仍需真实测试。</p>
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
        {builtin ? (
          <select
            value={builtinModel.id}
            onChange={(event) =>
              setBuiltinModelId(event.target.value as BuiltinEmbeddingModelId)
            }
          >
            {BUILTIN_EMBEDDING_MODELS.map((item) => (
              <option value={item.id} key={item.id}>
                {item.displayName} · {item.language} · {item.dimensions} 维
                {item.recommended ? " · 推荐" : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
      </label>
      <label>
        显示名称
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      {kind === "embedding" && (
        <label>
          向量维度
          <input
            required
            type="number"
            min={1}
            max={4096}
            value={builtin ? builtinModel.dimensions : embeddingDimensions}
            disabled={builtin}
            onChange={(event) =>
              setEmbeddingDimensions(Number(event.target.value))
            }
          />
          <small>
            {builtin
              ? "内置模型使用固定维度。"
              : "必须与服务商该模型实际返回的维度一致。"}
          </small>
        </label>
      )}
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
      <h3>默认模型与后台用途</h3>
      <p>
        等待配置任务：{settings.work.waiting} · 失败：{settings.work.failed}
      </p>
      {(
        [
          "realtime_default",
          "conversation_summary",
          "memory_extraction",
          "memory_embedding",
        ] as const
      ).map((purpose) => {
        const kind =
          purpose === "realtime_default"
            ? "realtime_voice"
            : purpose === "memory_embedding"
              ? "embedding"
              : "text";
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
      <h3>已有模型与音色</h3>
      {(["realtime_voice", "text", "embedding"] as const).map((kind) => (
        <div className="model-kind-group" key={kind}>
          <h4>
            {kind === "realtime_voice"
              ? "实时语音模型"
              : kind === "embedding"
                ? "Embedding 模型"
                : "文本模型"}
          </h4>
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
      {model.embeddingDimensions && (
        <small>向量维度：{model.embeddingDimensions}</small>
      )}
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
  openai_embeddings: "OpenAI-compatible Embedding",
  builtin_fastembed: "内置本地 Embedding",
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
  memory_embedding: "长期记忆向量化（内置 Mem0）",
};
