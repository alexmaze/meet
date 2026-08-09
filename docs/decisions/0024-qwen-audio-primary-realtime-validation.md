# ADR-0024：实时语音首选验证切换至 Qwen-Audio 3.0 Plus

- 状态：Accepted
- 日期：2026-08-09
- 修订：ADR-0001、ADR-0023
- 验证修订：2026-08-09，依据真实 WebRTC 上行排障结果修正音轨挂载时序

## 背景

第一段可运行代码最初以 `qwen3.5-omni-plus-realtime` 和 Flash 版本验证千问 WebRTC 链路。Meet 的最高优先级是自然、低延迟、能正确处理附和与插话的角色语音聊天，而图片理解主要服务于拍题和教学等特定场景。

阿里云百炼当前官方资料显示，`qwen-audio-3.0-realtime-plus` 是面向端到端实时语音对话的模型，支持 WebRTC，并提供融合声学感知与语义理解的 `smart_turn`。其输入模态只有 Audio 与 Text，不支持图片；`qwen3.5-omni-plus-realtime` 则支持 Text、Image、Video 与 Audio。

## 决策

1. 第一优先技术验证模型切换为 `qwen-audio-3.0-realtime-plus`，先验证纯语音角色聊天质量。
2. 浏览器继续通过 WebRTC 直传持续音频，由 Fastify 在服务端代理 SDP 握手。千问 WebRTC 当前为白名单能力，必须把阿里云商务提供的专用 Endpoint 配置为 `QWEN_REALTIME_ENDPOINT`；服务端自行追加固定 WebRTC 路径和模型参数，不能通过 Workspace ID 推导接入地址。DashScope API Key 与 Endpoint 均不进入浏览器。
3. 免提模式默认使用 `turn_detection.type: "smart_turn"`。当前 WebRTC 链路不支持 `turn_detection: null` 或 `input_audio_buffer.commit` 手动模式；界面“按住说话”只控制本地 RTP 麦克风音轨，松开后仍由 `smart_turn` 判断轮次。
4. 默认系统音色使用 `longanqian`。角色仍通过 Voice Profile 保存声音意图和供应商音色 ID，不把角色数据模型绑定到该音色。
5. `qwen-audio-3.0-realtime-plus` 最多保留 50 轮、累计 300 秒音频上下文；`max_history_turns` 的供应商默认值是 20。应用不能把这些上限当作长期记忆，长会话仍依赖本地确认记录、摘要和必要的会话轮换。
6. Qwen-Audio 不直接接收图片。通话中的图片或拍题输入由支持视觉的适配器分析，再把带来源标记的描述或结构化结果注入当前语音会话；`qwen3.5-omni-plus-realtime` 保留为图片与教学多模态候选，也可以使用独立视觉模型作为回退。
7. `qwen-audio-3.0-realtime-flash` 可以作为同系列成本对照，豆包 S2S-SC 仍是中文角色表现对照；在真实盲测完成前，不把应用永久绑定到任何一个模型或供应商。
8. 当前切换只确定验证顺序，不代表质量结论。真实凭据、手机与桌面设备、国内实际网络下的延迟、打断、字幕、稳定性和角色感测试仍待完成。
9. WebRTC 由服务端创建名为 `txt` 的 DataChannel。客户端在 `getUserMedia` 后先令 `microphoneTrack.enabled = false`，并在生成 offer 前执行 `sender.replaceTrack(null)`。从 `txt` 收到 `session.created` 后，客户端先通过同一通道发送 `session.update`，随后立即重新挂载仍为 disabled 的音轨；收到 `session.updated` 后才按免提或 PTT gate 启用发送并进入活动状态，确保首次发送音频前已经配置 `smart_turn`。不得等到 `session.updated` 后才挂载音轨，因为真实链路验证中该时序会导致上行 RTP 不可靠。后续控制事件与供应商事件也复用 `txt` 通道。
10. `smart_turn` 判定为有效插话时由服务端自动取消当前响应。客户端收到 `input_audio_buffer.speech_started` 时不主动发送 `response.cancel`；只有用户点击手动停止时才发送。若 `input_audio_buffer.speech_stopped.reason` 为 `turn_invalid`，无活动回复时回到聆听状态，原回复仍活动时恢复为角色说话状态。

## 理由

- `smart_turn` 直接对应 Meet 对语义轮次、附和声过滤和自然打断的优先需求；
- 在 `session.created` 阶段先发送 `session.update`、随后立即挂载 disabled 音轨，既遵循供应商示例顺序并保留 `session.updated` 前不发送音频的安全边界，也让 WebRTC 发送端及时恢复轨道；挂载与允许发送不能合并为 `session.updated` 后的单一步骤；
- 纯语音主链路先使用专门的实时语音模型，可以更直接地验证核心角色体验；
- 图片只出现在部分教学流程中，显式能力路由比要求单一模型覆盖全部场景更符合 Provider Adapter 边界；
- 保留 Omni、Audio Flash 和豆包对照，可以用同一脚本评估质量、能力与成本，而不是依据供应商描述提前锁定结论。

## 后果

- 千问事件与会话配置需要从 Omni 的 `semantic_vad`、Omni 音色和独立转写设置迁移到 Audio 的 `smart_turn` 与 Audio 音色配置；协议 schema 不接受 WebRTC 手动模式配置；
- 当前 WebRTC 安全边界保持不变，但模型允许列表、白名单 Endpoint 配置和协议 schema 需要按 Qwen-Audio 更新；
- 客户端必须区分服务端自动语义打断与用户手动停止，不能在每个 `speech_started` 事件上重复取消响应；
- 客户端必须区分“重新挂载音轨”和“允许音轨发送”：前者发生在 `session.created`，后者只在 `session.updated` 后由本地输入 gate 决定；
- 图片入口不能直接调用 Audio 会话的图片通道，必须经过能力路由；
- 50 轮与 300 秒只是供应商上下文上限，持久化、摘要、记忆和断线恢复仍由应用负责；
- 完成真实设备测试后，依据可观测指标和盲测结果决定默认生产模型。

## 官方依据

- [Qwen-Audio 实时语音对话](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)
- [qwen-audio-3.0-realtime-plus 模型信息](https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-plus)
- [Realtime API 协议支持矩阵](https://help.aliyun.com/zh/model-studio/realtime-api-overview)
- [Realtime API 接入模型与应用](https://help.aliyun.com/zh/model-studio/realtime-connect-model)
- [Realtime API Token 鉴权](https://help.aliyun.com/zh/model-studio/realtime-token-authentication)
- [qwen3.5-omni-plus-realtime 模型信息](https://help.aliyun.com/zh/model-studio/qwen3-5-omni-plus-realtime)
