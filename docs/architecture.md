# Meet 技术架构草案

状态：Draft  
更新时间：2026-08-10

本文记录已经达成共识的架构边界。具体依赖版本在项目初始化时依据兼容性测试锁定。

已确定的实现基线：前后端统一使用 TypeScript；Web 使用 React、Vite 和 `vite-plugin-pwa`；API 使用 Fastify；PostgreSQL schema 和迁移使用 Drizzle ORM；共享协议使用 Zod；后台任务使用 `pg-boss`；媒体通过本地目录或 S3 兼容 MediaStore 保存；代码通过 pnpm workspace 组织为包含 Web、API 和共享协议包的 Monorepo。

当前部署前提：用户主要位于中国大陆，应用服务运行在国内云服务器，通过浏览器访问。

一个私有部署实例服务于一个家庭。实例内支持多个独立登录账号，但不支持公众自助注册或多个家庭租户。

应用层不设置全局并发实时会话上限。每个会话独立维护供应商连接、音频状态、角色上下文和用量；服务器资源不足或供应商返回配额限制时，将错误返回对应会话，不能主动终止其他成员通话来腾出名额。

## 1. 总体结构

```text
浏览器
├── 角色与历史记录界面
├── 麦克风采集 / 音频播放
├── WebRTC 或 WebSocket 实时连接
└── 统一客户端事件层
        │
私有应用服务
├── 家庭账号与登录会话
├── 角色配置和分配
├── 会话和记忆
├── 实时会话凭据或连接代理
├── Provider Adapter
└── 用量、错误和延迟记录
        │
云端实时模型
├── Qwen-Audio 3.0 Realtime Plus（第一版默认语音实现）
├── Qwen3.5 Omni Plus Realtime（图片与教学多模态候选）
├── 豆包实时语音 3.0 全双工（Seeduplex，对照验证）
└── 未来的其他供应商
```

建议的仓库逻辑边界：

```text
apps/
├── web       # PWA、角色管理和实时通话界面
├── api       # 登录、角色、会话、供应商适配和工具调用
└── worker    # pg-boss worker；摘要、记忆提取和媒体清理
packages/
├── protocol  # 实时事件、API DTO 和校验结构
├── database  # PostgreSQL schema、迁移和查询
├── realtime  # 供应商无关的会话状态与适配器接口
├── jobs      # 队列名称、任务 payload schema 和入队接口
├── media     # MediaStore 接口、本地目录与 S3 兼容实现
└── config    # 共享配置定义，不包含真实密钥
```

API 负责在业务事务成功时入队；Worker 执行长耗时和可重试任务。两者使用同一 PostgreSQL 与 `pg-boss` schema，不引入 Redis。

框架职责：

- React 负责 PWA 页面、实时通话状态和教学辅助渲染；
- Vite 负责开发与 Web 构建，`vite-plugin-pwa` 生成 Manifest 与 Service Worker；
- PWA 更新采用用户确认刷新，不在活跃通话中自动重载；
- Fastify 按插件划分认证、角色、会话、媒体、供应商、工具和诊断模块；
- Fastify 请求生命周期负责认证、授权、运行时校验、错误映射和请求日志；
- `@fastify/websocket` 只用于确实需要 API 中继的长连接，并复用 Fastify 认证钩子；
- 浏览器能够安全直连供应商 WebRTC 时，媒体不经过 Fastify；
- Drizzle 管理 schema 和版本化迁移，复杂且性能敏感的查询允许使用参数化 SQL；
- Zod schema 是 HTTP DTO、实时事件和任务 payload 的运行时事实来源；TypeScript 类型从 schema 推导，避免手写两份结构；
- `pg-boss` 负责摘要、记忆提取、临时媒体清理和其他可重试后台任务；
- MediaStore 隔离本地目录与 S3 兼容对象存储差异，业务代码只保存不透明对象 key 与元数据。

服务关闭时先停止接收新请求，再关闭或通知活动 WebSocket，等待有限时间完成持久化，最后关闭数据库连接。活动的浏览器直连供应商会话在连接断开后进入既定重连/暂停流程。

### 1.1 后台任务规则

第一版队列至少包括：

- `conversation.finalize`：生成会话摘要并汇总用量；
- `memory.extract`：提取自动记忆与待确认建议；
- `media.expire`：清理未保留的临时音频和过期预览资源；
- `avatar.generate`：生成并暂存 AI 头像预览。

每个任务 payload 都使用 Zod 校验并包含业务幂等键。任务处理器必须可以安全重试；最终失败进入死信状态并在管理员诊断页可见，但第一版不安装独立队列 Dashboard。

### 1.2 MediaStore 边界

```ts
interface MediaStore {
  put(input: MediaPutInput): Promise<MediaObject>;
  open(key: string): Promise<ReadableStream>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

- `LocalMediaStore` 把对象保存在配置目录，默认用于简单私有部署；
- `S3MediaStore` 连接 S3 兼容对象存储；
- 数据库保存 object key、所有者、媒体类型、大小、校验值、保留状态和过期时间；
- 私人媒体的读取必须先经过 API 授权，业务数据不得依赖永久公开 URL；
- 删除操作设计为幂等，数据库记录与对象清理通过后台补偿任务最终一致。

当前基础实现已经提供 `@meet/media`、`LocalMediaStore`、注入式 S3 兼容对象客户端边界、媒体元数据表、受权读取/保留/删除 API 与 `media.expire` Worker。临时媒体在创建元数据的同一数据库事务中投递带到期版本的延迟任务；Worker 先原子认领元数据，再幂等删除对象并完成数据库状态。旧到期任务不能删除已经保留或被重新设置期限的媒体。录音采集与封装尚未接入该边界。

浏览器可以按供应商推荐方式建立媒体连接，但长期 API 密钥必须只存在于私有应用服务。服务端负责签发临时会话信息或代理必要的握手请求。

公网浏览器访问需要使用 HTTPS，以便稳定获得麦克风等浏览器媒体能力；域名、证书和具体云平台由项目所有者自行处理。

## 2. 供应商适配边界

千问适配器推荐 `qwen-audio-3.0-realtime-plus`：浏览器通过同源、带账号认证的 Fastify WebSocket 连接中继，中继使用数据库解析出的服务端凭据连接供应商 WebSocket。浏览器发送 16 kHz PCM16 单声道分片，并用应用持有、可按 `response_id` 和 generation 清空的 24 kHz PCM 队列播放模型音频。免提会话配置为 `turn_detection.type: "smart_turn"`，推荐系统音色为 `longanqian`。模型与音色必须由管理员测试、启用并绑定角色，没有隐式运行默认。该模型最多保留 50 轮、累计 300 秒音频上下文，其中 `max_history_turns` 默认是 20；这些是供应商的短期上下文边界，不能替代应用自己的会话记录、摘要和长期记忆。

管理员在模型设置中录入商务提供的千问 Endpoint；不能从 Workspace ID 拼接或推导信令域名。适配器校验 HTTPS/WSS 地址并为千问链路构造固定协议路径。API Key、上游鉴权头和完整角色提示词均不下发浏览器，也不进入常规日志。Endpoint 可作为非敏感连接元数据返回管理员界面。

默认 WebSocket 建连时，浏览器先启动带回声消除、降噪和自动增益约束的麦克风采集与可清空播放器，再连接同源中继。中继先校验 Origin、登录状态、角色可见性、Provider Profile 与速率/帧大小边界，然后连接固定的供应商地址。浏览器只能发送允许列表内的会话配置、PCM append、文本、响应创建和取消事件；模型、声音和角色指令由服务端解析角色运行时配置后约束。

应用持有每个输出 PCM 分片的 `response_id` 和本地播放 generation。收到有效插话或手动停止时，客户端先同步增加 generation、停止已安排节点并清空队列，再处理上游取消；迟到的旧响应分片直接丢弃。字幕投影使用同一响应标识，因此旧回复不能在新字幕出现后重新发声。

千问链路不支持 `turn_detection: null` 或 `input_audio_buffer.commit` 手动模式。界面的“按住说话”只控制是否继续发送本地 PCM 分片，松开后仍由 `smart_turn` 收尾。有效插话由供应商自动取消当前响应；只有用户点击手动停止时才显式发送取消事件。若 `speech_stopped.reason` 为 `turn_invalid`，前端在没有活动回复时回到聆听，有活动回复时恢复角色说话状态，但不会回填已经清掉的旧 PCM。

现有浏览器直连 WebRTC 实现保留为实验和诊断路径，用于比较端到端延迟与回声处理。它不能按响应标识清空浏览器 RTP 接收缓冲，因此不是“确定性打断”的默认或验收实现。

Qwen-Audio 的输入模态只有 Audio 与 Text，能力声明必须把图片输入标记为不支持。`qwen3.5-omni-plus-realtime` 保留为图片与教学多模态候选；也可以先由独立视觉模型分析图片，再把带来源标记的文本或结构化教学结果注入 Audio 会话。模型选择属于 Provider Profile，不写死在角色、会话或前端页面结构中。

不尝试抹平所有供应商能力，只统一应用真正依赖的最小接口：

```ts
interface RealtimeProvider {
  createSession(input: SessionInput): Promise<SessionConnection>;
  updateInstructions(input: InstructionUpdate): Promise<void>;
  sendText(text: string): Promise<void>;
  sendImage(image: ImageInput): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  onEvent(handler: (event: RealtimeEvent) => void): Unsubscribe;
}
```

统一事件至少包括：

- `connection.changed`
- `connection.reconnecting`
- `connection.resumed`
- `user.speech.started`
- `user.speech.ended`
- `user.transcript.delta`
- `assistant.response.started`
- `assistant.audio.delta`
- `assistant.transcript.delta`
- `assistant.response.completed`
- `assistant.response.interrupted`
- `assistant.artifact.updated`
- `tool.call.requested`
- `tool.call.completed`
- `usage.updated`
- `error`

供应商特有能力保留在 `capabilities` 和扩展配置中，不为追求形式统一而删除高级能力。

适配器需要声明是否支持在当前实时会话中直接输入图片。如果供应商不支持，服务端可以先使用兼容的视觉模型生成图片描述，再把描述作为带来源标记的上下文注入实时会话。应用层不应假设所有供应商拥有相同的多模态通道。

教学辅助内容使用供应商无关的结构化事件更新，例如：

```ts
type TeachingArtifact = {
  id: string;
  kind: "problem_image" | "markdown" | "latex" | "step" | "conclusion";
  content: string;
  order: number;
};
```

前端负责安全渲染 Markdown 和 LaTeX，并按 `id` 增量更新卡片；不要从语音转写中猜测公式结构。

工具调用统一经过服务端的按角色允许列表：

```ts
interface ToolHandler {
  name: string;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
```

第一版只注册确定性的计算器工具。实时模型提出调用，服务端执行并把结构化结果送回当前会话。工具接口保留扩展性，但不实现联网搜索、天气或通用计算机操作。

实时会话需要支持两种输入模式：

- `hands_free`：默认模式，使用供应商语义轮次检测或适配层等价能力；
- `push_to_talk`：用户按住时采集并发送语音，松开后提交当前轮次。

设备可以记住用户最近选择的输入模式，但每次通话都允许即时切换。

会话进入空闲状态后启动沉默计时器。达到角色配置的延迟时最多触发一次自然追问；收到用户语音、页面进入不可交互状态或网络异常时取消计时器。追问后若用户仍未回应，不再次自动生成内容。

每个客户端事件和持久化消息需要稳定 ID 与单调递增序号。重连时客户端携带最后确认序号，服务端只补发缺失事件并幂等写入，防止转写、消息和用量重复。

连接状态机至少包括：

```text
connecting → active → reconnecting → active
                         └──────────→ paused → closed
```

- 网络中断进入 `reconnecting`，自动尝试恢复最多约 30 秒；
- 页面回到前台时检测媒体轨道与信令连接，失效则进入同一恢复流程；
- 恢复时优先继续供应商原会话；无法恢复时使用已保存的角色上下文和最近确认序号创建替代会话；
- 当前模型连续重试失败后进入 `paused`，等待用户选择重试或结束；
- 不允许恢复逻辑自动切换供应商、模型或 Voice Profile。

当前 Qwen-Audio WebSocket 协议的一条连接对应一个供应商会话，没有跨连接继续原会话的接口，因此默认实现直接使用替代会话恢复。浏览器在意外关闭时关闭麦克风 gate、清空带 generation 的 PCM 队列和未确认草稿，在 30 秒窗口内按 1、2、4、8 秒退避连接同一角色运行时；返回前台会取消等待并立即尝试。每次尝试前先调用现有幂等消息接口补写待确认的完整字幕，API 随后从当前活动会话和普通关系历史加载有界上下文。临时会话只允许加载当前会话自身的消息。替代会话收到 `session.updated` 后恢复麦克风，但保留“已经请求过开场”的客户端标志，不重复发送开场请求。30 秒超时进入 `paused`，保留媒体与业务会话供用户手动继续重试或结束保存；未完成的旧 PCM 和转写草稿有意不恢复。

豆包 Provider 使用实时语音 3.0 全双工接口（Seeduplex）。浏览器仍只连接同源 Fastify WebSocket；中继用数据库解析出的服务端 `X-Api-Key` 连接管理员配置的适配器端点，并自行发送 `session.create`。管理员可以配置适配器兼容的模型 ID；浏览器只能发送 PCM append、强制判停、回复取消、保存的开场白合成和优雅关闭事件，不能覆盖模型、声音或角色 Prompt。

豆包链路复用 16 kHz、20 ms PCM 麦克风分片与 24 kHz 可清空 PCM 播放队列。收到用户转写 started 时立即失效旧播放 generation，并在存在活动回复时发送 `response.cancel`；PTT 松开额外发送 `input_audio_buffer.commit`。正常结束发送 `session.close` 并有限等待 `session.closed`。重连继续创建同模型、同音色的替代会话，由应用注入已确认的有界上下文，不静默切换到千问。

豆包的系统提示词与上下文共享约 12K 预算。适配器将角色指令、关系摘要和最近已确认消息编译为不超过 12,000 字符的 `instructions`；PostgreSQL 中的消息、摘要和长期记忆仍是权威来源，不能把供应商保存的最近轮次当成长期存储。

## 3. 角色和音色数据边界

建议的数据结构：

```ts
type Character = {
  id: string;
  ownerId?: string;
  visibility: "builtin" | "family" | "private";
  name: string;
  description: string;
  avatar?: string;
  persona: PersonaDefinition;
  openingLine?: string;
  providerProfileId: string;
  voiceProfileId: string;
  conversationPolicy: {
    firstSpeaker: "assistant" | "user";
    responseStyle: "concise" | "adaptive" | "detailed";
    silenceFollowUp: {
      enabled: boolean;
      delayMs: number;
      maxConsecutivePrompts: 1;
    };
  };
  visualProfile: {
    avatarUrl: string;
    animationStyle: "subtle";
  };
};

type CharacterCardExport = {
  schemaVersion: string;
  character: {
    name: string;
    description: string;
    persona: PersonaDefinition;
    openingLine?: string;
    conversationPolicy: Character["conversationPolicy"];
    voiceStyle: VoiceProfile["style"];
  };
  avatar?: ExportedAsset;
};

type UserAccount = {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  accountType: "admin" | "adult" | "child";
  status: "active" | "disabled";
  guardianHistoryAccess?: "allowed" | "denied";
};

type PasswordCredential = {
  userId: string;
  passwordHash: string;
  passwordChangedAt: string;
};

type VoiceProfile = {
  id: string;
  provider: "qwen" | "doubao" | "openai" | "gemini" | "elevenlabs";
  type: "preset" | "cloned";
  providerVoiceId: string;
  displayName: string;
  style: {
    pace?: "slow" | "normal" | "fast";
    energy?: "low" | "medium" | "high";
    warmth?: "low" | "medium" | "high";
    emotionInstruction?: string;
  };
  settings?: Record<string, unknown>;
};
```

角色不直接保存某个供应商的全部会话参数。更换模型或从预设音色升级到克隆音色时，只替换关联的 Provider Profile 或 Voice Profile。

模型控制面由四层组成：`model_connections` 保存适配器、活动连接和候选修订；`provider_profiles` 保存实时或文本模型及验证状态；`voice_profiles` 保存内置或自定义音色；`model_purpose_bindings` 保存实时默认、摘要和记忆用途。管理员写接口使用 Zod 校验和 revision 乐观锁，并写入不含凭据的 `model_configuration_audit_events`。API 序列化连接时只返回 Endpoint、元数据与 `hasCredential`，永不返回活动或候选 API Key。凭据当前按产品决定以数据库明文保存，因此 PostgreSQL 与快照属于敏感密钥存储边界。

实时通话、试听和握手都在请求开始时解析角色绑定的已启用 Profile、Voice 与活动 Connection，并把解析结果固定在该连接生命周期内。Provider Adapter 接收解析后的运行时连接；共享协议只校验非空模型 ID，适配器负责协议兼容性，管理状态负责验证与启用门槛。模型停用后既有连接不受影响，新请求返回可解释的配置错误；系统不自动替换模型或音色。

会话完成事务向 `ai_work_items` 分别写入摘要和记忆工作。存在有效用途绑定时，工作项保存固定 `model_profile_id` 并通过 pg-boss 入队；不存在时保存为 `waiting_configuration`。管理员建立用途绑定后，协调器在数据库事务中把对应等待项改为 queued 并补发。Worker 每个任务按 payload 的模型配置 ID 解析 OpenAI-compatible 连接，允许已入队任务继续使用后来停用但未删除的配置。摘要和记忆结果保存分析器 Profile ID 与实际模型 ID，形成可追溯链路。

Voice Profile 属于角色定义而不是用户偏好。共享角色的所有用户解析到同一个 Voice Profile，不建立账号级覆盖层。未来克隆音色仍使用相同结构，只把 `type` 改为 `cloned` 并替换供应商声音 ID。

音色推荐服务读取结构化角色卡和当前供应商可用音色元数据，返回至多 3 个带推荐理由的候选。最终 Voice Profile 只能在用户试听并确认后保存；推荐服务不能静默决定角色声音。

千问和豆包适配器内置已知音色目录，管理员也可以添加音色 ID 与显示名。角色创建与编辑页的试听请求只携带目录内 Voice Profile ID；API 解析对应模型和供应商音色后，使用固定短句建立一次短时上游连接，把返回的 24 kHz PCM 封装成 WAV。自定义音色只有测试成功后才进入可选目录。试听接口按账号与来源限速，不创建 Conversation 或 Message，不接收任意试听文案，也不把供应商凭据下发浏览器。

`PersonaDefinition` 支持两种模式。默认结构化模式包含背景、核心性格、与用户关系、说话习惯、情绪风格、对话目标和示例台词，系统根据这些字段生成运行时提示词。完整 Prompt 高级模式保存一段最多 12,000 字符的自定义文本，并直接将其作为角色人设指令主体；运行时不得再混入结构化人设栏目。缺少模式字段的既有数据按结构化模式读取。

两种模式只改变角色人设指令的来源。角色名称、Provider Profile、Voice Profile、视觉配置和客户端运行控制仍使用独立字段；需要模型理解的开场、回复和声音策略可以在角色人设主体之后追加。编辑器切换模式时保留另一模式的草稿，但只有当前模式参与运行时编译。

开场、沉默追问和默认回复长度属于 `conversationPolicy`，不埋在不可解析的提示词中。用户在通话中的“简单点”“详细点”“慢一点”等指令只更新当前会话状态，除非用户明确要求设为角色默认值。

声音风格优先映射到供应商原生的音色和会话控制；供应商缺少对应参数时，将其编译为简短、供应商适配的自然语言指令。应用保存的是供应商无关的角色意图，不直接暴露专有参数作为核心数据。

AI 快速创建角色时调用非实时文本生成接口返回结构化草稿，服务端校验数据格式后再交给用户确认。该能力不应与实时语音会话实现耦合。

AI 头像生成读取确认后的角色卡，生成结果先作为临时资源返回预览，只有用户确认后才转为角色资产。角色保存不依赖头像生成成功。

用户上传角色形象时，浏览器把 JPG、PNG 或 WebP 原始二进制发送到带账号认证的媒体接口，单个文件最大 5 MB。服务端同时校验声明的 MIME 类型与文件签名，不接受 SVG 或外部 URL。上传结果先以 24 小时临时 `character_avatar` 保存；角色创建或更新成功前将其转为长期保留。媒体内容只允许所有者或能够看到引用该头像角色的账号读取，家庭共享角色的形象因此可供全家使用，私人角色的形象仍保持隔离。

角色导出使用带 `schemaVersion` 的文件或资源包。导入时先校验版本、结构和资源大小，再生成新的角色 ID 与本地资产引用。导出内容不得包含用户 ID、会话、记忆、录音、供应商密钥或可复用的授权信息。

所有会话、消息、摘要和长期记忆都必须带有 `userId`。内置角色和管理员角色使用家庭可见性；其他成员创建的角色默认私有，可以主动改为家庭共享。共享角色只共享角色定义，不共享各账号与该角色的对话或记忆。

家庭资料需要作为独立实体保存，不与任何成员的私人记忆表混用：

```ts
type FamilyFact = {
  id: string;
  content: string;
  source: "manual";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
```

## 4. 对话和记忆

一次实时会话由四层上下文组成：

1. 固定角色设定；
2. 用户档案与该角色的长期记忆；
3. 之前会话的压缩摘要；
4. 当前实时会话的最近对话。

普通会话默认加载前述四层上下文。临时会话仍加载角色设定和用户主动维护的基础资料，但不加载可选的关系延续摘要，也不会在结束时写入私人长期记忆；具体加载边界在实现前通过体验测试确认。

摘要和长期记忆已经作为独立后台处理切片实现。API 首次把普通会话从活动状态收口为完成状态时，通过 pg-boss 的 Drizzle 事务适配器在同一数据库事务中投递 `conversation.finalize` 与 `memory.extract`；临时会话只投递前者。Worker 使用供应商无关的 `ConversationAnalyzer` 接口，首个适配器通过千问兼容 Chat Completions JSON Mode 生成结构化结果。摘要按会话幂等覆盖；候选记忆按账号、角色和规范化内容指纹幂等合并。明确、稳定且置信度不低于 0.9 的事实进入 `active`，其他稳定推断进入 `suggested`，瞬时信息丢弃；用户拒绝或删除后的同内容不会被任务重试自动恢复。

普通续聊先绑定一个已认证、属于当前账号且与当前角色一致的活动会话，再读取该账号与该角色的已确认长期记忆、最近最多 4 份普通会话摘要和最近最多 24 条普通会话消息。API 分别在 8,000 字符关系上下文预算和 12,000 字符原文预算内裁剪。Qwen WebSocket 中继收到供应商 `session.updated` 后，先以供应商原生的 `conversation.item.create` 系统项注入记忆与摘要，再按时间顺序注入最近原文，最后把 `session.updated` 转发浏览器，使角色开场请求一定排在上下文之后。临时会话在数据库和服务层都清空跨会话摘要、记忆与原文；任何跨账号、跨角色、已结束或不存在的当前会话标识都按未找到处理。

推荐流程：

```text
开始通话
  → 加载角色、人际关系和长期记忆
  → 创建云端实时会话
  → 持续保存文本事件
  → 达到上下文阈值时生成增量摘要
  → 必要时用摘要无感轮换实时会话
  → 通话结束后提取候选长期记忆
  → 保存会话摘要与用量
```

长期记忆需要有来源会话、更新时间和可删除状态，避免无法解释或无法纠正的记忆。

记忆记录至少区分：

```ts
type MemoryStatus = "active" | "suggested" | "rejected" | "deleted";

type CharacterMemory = {
  id: string;
  userId: string;
  characterId: string;
  sourceConversationId: string;
  content: string;
  confidence: number;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
};
```

只有明确、稳定且置信度高的事实可以直接进入 `active`；推断和存疑内容进入 `suggested`，等待用户处理。置信度阈值需要在实际对话样本上调校，不能仅相信模型自报分数。

## 5. 打断与音频状态

自然打断不能只依靠 UI 停止本地播放器，需要同时完成：

1. 浏览器检测或收到用户开始说话事件；
2. 立即停止并清空尚未播放的角色音频；
3. 通知云端取消当前响应；
4. 截断服务端保存的角色消息，使历史只包含用户实际听到的部分；
5. 继续发送用户新的话语。

客户端播放队列必须记录音频时间戳，否则无法准确维护“角色实际说到了哪里”。

默认采用供应商提供的语义打断能力，尽量避免把“嗯”“对”等简短附和或背景声音识别为真正插话。所有供应商适配器都必须实现显式 `interrupt()`；界面上的停止按钮直接调用该能力，不依赖 VAD。

## 6. 数据与凭据

- API 密钥只保存在服务端环境变量或私有密钥文件中；
- 浏览器只能得到短期有效的会话凭据或经过服务端代理的连接描述；
- 默认保存文本转写、结构化事件、摘要、记忆和用量；
- 默认不长期保存原始麦克风和模型音频；
- 为支持“结束时保留录音”，通话期间可以把双向音频写入有过期时间的临时对象；用户确认保留后转为持久记录，否则自动清理；
- 通话开始前开启录音时可以直接标记为待持久化，但仍需处理异常中断和不完整文件；
- 聊天图片作为会话附件持久化并记录所有者与会话 ID；单独删除图片时清理对应对象，删除会话时级联清理附件；
- 日志需要过滤提示词中的敏感字段和所有授权头；
- 单实例、家庭多账号的第一版可以使用轻量关系型数据库，具体实现待技术栈确定后选择；
- 服务端负责登录验证和会话管理，不允许仅依靠浏览器传入的 `userId` 访问数据；
- 不提供公开注册、邀请注册或家庭邀请码注册接口；成员账号只能通过管理员接口创建；
- 所有账号使用用户名和服务端验证的密码登录，数据库只保存密码哈希；
- 已认证账号修改自己的密码时必须再次验证当前密码；密码更新、审计记录与其他有效登录会话撤销在同一事务中完成，发起请求的当前会话继续有效；
- 浏览器只保存当前账号的登录会话；退出时撤销当前会话并清除会话 Cookie，不提供多个账号的快速头像切换器；
- 管理员重置成员密码时写入新的密码哈希，并撤销该成员全部现有登录会话；不提供查看或恢复原密码的能力；
- 管理员密码通过仅能在服务器环境执行的管理命令重置，同时撤销原管理员登录会话；
- 各账号的历史、摘要和长期记忆按账号隔离；
- 管理员专属接口负责供应商凭据和全局设置；
- 家庭资料通过单独的授权规则访问，不能通过私人记忆查询接口泄露其他账号内容。

权限矩阵：

| 数据或操作 | 管理员 | 成人 | 儿童 |
|---|---|---|---|
| 修改供应商和全局设置 | 是 | 否 | 否 |
| 读取自己的私人历史与记忆 | 是 | 是 | 是 |
| 读取成人账号私人内容 | 否，除本人外 | 否，除本人外 | 否 |
| 读取儿童账号私人内容 | 按该儿童账号配置，默认允许 | 否 | 否，除本人外 |
| 创建私人角色 | 是 | 是 | 否 |
| 直接共享自己创建的角色 | 是 | 是 | 不适用 |
| 创建、编辑或删除家庭资料 | 是 | 否 | 否 |

儿童账号在服务端无角色创建、编辑或共享权限，不能只依赖界面隐藏按钮。家庭资料写接口同样只允许管理员调用。

这里的数据隔离是应用内授权边界。拥有服务器和数据库控制权的基础设施管理员不在隔离威胁模型内；密码重置操作需要记录时间和目标账号，但项目不承诺以端到端加密阻止服务器所有者访问数据。

## 7. 预置数据与备份边界

- 首次初始化数据库时安装三个带固定系统标识的预置角色；
- 管理员可以复制预置角色形成普通共享角色；
- 直接编辑预置角色时保留其系统来源和版本，以便恢复当前应用版本的原始配置；
- 角色记忆与用户会话不属于预置配置，恢复角色原版时不得删除或覆盖成员记忆；
- 应用不开发全量备份、下载或恢复模块；
- 数据库、媒体对象和运行配置的灾难恢复依赖云服务器磁盘快照；
- 快照周期、保留数量和恢复演练属于部署运维配置。

## 8. 可观测性

每次会话至少记录：

- 供应商、模型和音色；
- 连接建立时间；
- 每轮用户结束说话到首个角色音频的延迟；
- 插话到停止播放的延迟；
- 自动轮次结束延迟；
- 语义打断的误触发和漏触发次数；
- 重连、取消和错误事件；
- 重连次数、恢复耗时、恢复后重复或缺失事件数量；
- 输入、输出用量和估算成本；
- 会话时长；
- 每轮角色语音时长，以及用户主动要求缩短或展开回答的次数。

这些数据同时用于模型选型和后续回归测试，不依赖主观印象决定供应商。

## 9. 实施顺序

1. 已完成单页面实时语音技术样例，预置推荐 `qwen-audio-3.0-realtime-plus`，实际运行默认由管理员测试、启用并绑定；
2. 建立 PostgreSQL、Drizzle、共享配置与 Provider Adapter 基础，把现有千问实现收敛到供应商边界内；
3. 实现管理员初始化、家庭成员管理、登录会话和服务端授权隔离；
4. 已以预置角色、结构化角色卡、角色权限、角色首页和实时通话完成第一个业务纵向切片；
5. 已实现会话与消息持久化、私人历史记录、稳定消息 ID、连续确认序号、幂等保存、同账号同角色的有界最近历史续聊，以及约 30 秒替代会话恢复和缺失消息补写；
6. 已实现摘要、长期记忆、`pg-boss` Worker、分级记忆审阅、后续通话上下文注入，以及 MediaStore、媒体元数据、受权读取/保留/删除和临时媒体清理基础；下一步接入按次录音采集与历史回放；
7. 接入图片能力路由、教学辅助和计算器工具，使用 Qwen3.5 Omni Plus Realtime 或独立视觉分析完成拍题流程；
8. 完成移动浏览器与 PWA 适配，并在上述业务切片中持续补齐统一事件、延迟、打断、用量和错误记录；
9. 真实手机与桌面设备测试、家庭噪声测试、Qwen-Audio Flash 成本对照和豆包全双工实时语音盲测与业务开发并行，作为 MVP 验收和默认模型调整依据，不再阻塞第 2–8 项；
10. 后续按实际质量、成本或能力缺口新增供应商适配器和克隆音色，不为了形式完整预建未使用实现。

## 10. 已确定的部署边界

- 使用者和浏览器主要位于中国大陆；
- 应用服务部署在国内云服务器；
- 选择模型供应商时优先考虑国内网络路径和国内节点；
- 项目不建设公开多租户平台；
- 一个实例支持多个家庭成员独立登录；
- 角色、会话、记忆和供应商密钥保存在该私有服务中；
- 具体云平台、服务器规格、域名、HTTPS、磁盘快照和生产运维由项目所有者自行负责，不作为应用架构选型任务；
- 应用只提供运行时配置入口和可部署产物，除非项目所有者后续明确提出要求，不绑定某个云厂商的部署服务。

## 11. 已确定的终端和界面边界

- 手机和平板优先，桌面浏览器兼容；
- 默认通话页是以角色为中心的沉浸式界面；
- 同一个通话框架可以按角色配置展开字幕、题目和辅助内容；
- 教学角色默认允许使用辅助区域，陪伴角色默认保持简洁；
- 轻量状态动画的视觉细节和教学辅助组件布局在 UI 设计阶段确定；
- 第一版不做音素级口型同步；头像动画直接由统一实时事件驱动。
- Web 客户端提供 Manifest、图标和 Service Worker，支持安装为独立窗口 PWA；
- Service Worker 只缓存应用外壳和安全的静态资源，不缓存 API 密钥、私人响应或实时音频；
- 不注册 Web Push，不实现后台定时任务或主动来电通道；
- 断网时可以显示连接错误和已缓存外壳，但不能创建离线 AI 会话。
- 后台通话只做浏览器能力范围内的尽力保持，不承诺原生电话级持续运行；检测到后台挂起后，在返回前台时执行统一重连流程。
- 手机主导航为角色、历史、记忆、我的，桌面使用同一页面路由并呈现为侧边栏；
- 管理员功能作为我的页面内的权限路由加载，不建立单独前端应用；
- 首页查询分别返回最近通话、收藏和当前账号可见角色，客户端按区块组合；
- 角色卡的通话操作与详情操作使用独立可访问控件；成人与儿童使用相同交互，差异仅来自服务端权限和对应操作的显隐；
- 基础设计 token 保持中性，角色主题通过受约束的 accent、背景资源和氛围参数覆盖；
- 通话布局包含全幅模糊背景、大幅静态角色立绘、当前字幕浮层、可展开辅助区和底部固定控制栏。
