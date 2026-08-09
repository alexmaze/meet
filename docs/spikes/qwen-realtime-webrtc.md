# 千问 Qwen-Audio 3.0 Realtime WebRTC 技术验证

状态：Implemented，等待真实凭据与设备实测  
更新时间：2026-08-09

## 目标

这个样例只回答第一阶段最重要的问题：`qwen-audio-3.0-realtime-plus` 是否能在家庭使用的浏览器中提供自然、低延迟、可打断、有字幕的角色语音聊天。

样例不是完整产品。它暂不包含账号、角色库、历史、长期记忆、数据库、录音、图片、工具调用或豆包适配。

## 运行

```bash
cp .env.example .env
pnpm install
pnpm dev
```

在 `.env` 中至少填写：

```dotenv
REALTIME_SPIKE_ENABLED=true
DASHSCOPE_API_KEY=在服务端填写真实值
QWEN_REALTIME_ENDPOINT=商务提供的Endpoint主机名
```

千问 WebRTC 当前是白名单能力，需要先联系阿里云商务取得专用 Endpoint。推荐填写纯 hostname；也接受不带路径、查询参数或端口的 HTTPS origin。服务端会自行追加 `/api/v1/webrtc/realtime?model=...`，不能通过 Workspace ID 推导接入地址。

浏览器打开 `http://localhost:5173`。localhost 可以获得麦克风权限；从其他设备访问时需要 HTTPS。

API 健康检查：

```bash
curl http://127.0.0.1:8787/api/health
```

不要把 `.env`、API Key、白名单 Endpoint 或带鉴权信息的请求日志提交到版本库。

## 已实现链路

```text
浏览器获取麦克风，并立即将 audio track 设为 disabled
  → 创建 RTCPeerConnection 和 audio sender
  → 生成 offer 前通过 sender.replaceTrack(null) 暂时移除 track
  → 创建 bootstrap DataChannel 以触发 SDP 数据通道协商
  → 收集完整 ICE SDP offer
  → POST /api/realtime/qwen/sessions
  → Fastify 添加服务端 Authorization 并代理原始 SDP
  → 浏览器设置千问 SDP answer
  → 服务端创建名为 txt 的 DataChannel
  → 从 txt 收到 session.created，先发送 session.update，随即重新挂载仍为 disabled 的 track
  → 收到 session.updated，按免提或 PTT 本地 gate 启用发送并进入 active
  → 音频走 WebRTC，控制事件和字幕走 txt DataChannel
```

浏览器永远拿不到 DashScope API Key。Fastify 只代理建立 WebRTC 所需的 SDP，不中继持续音频。

重新挂载音轨与允许发送是两个独立阶段：`session.created` 时先发送 `session.update`，随后立即恢复 disabled track；`session.updated` 后才由本地 gate 决定是否启用。真实链路排障中，等到 `session.updated` 后才执行 `replaceTrack` 会出现上行 RTP 不可靠，因此不能把两个阶段合并。

## 会话配置

样例使用：

- `modalities: ["text", "audio"]`；
- 默认模型 `qwen-audio-3.0-realtime-plus`；
- 云端系统音色，默认 `longanqian`；
- `turn_detection.type: "smart_turn"`，由声学感知与语义理解共同判断轮次；
- 可选在 `session.updated` 后先用 `conversation.item.create` 注入一条不展示的开场用户指令，再发送 `response.create` 让角色先打招呼；Qwen-Audio 在没有用户消息时会拒绝直接生成响应。

可在页面中切换：

- 已由服务端允许的 Qwen-Audio Realtime 模型；
- Voice 名称；
- 本次通话的角色指令；
- 免提或按住说话；
- 是否由角色先开口。

## 字幕、轮次与打断

样例处理以下主要服务端事件：

- `session.created`、`session.updated`；
- `input_audio_buffer.speech_started`、`speech_stopped`；
- `conversation.item.input_audio_transcription.delta`、`completed`；
- `response.created`、`response.audio_transcript.delta`、`response.audio_transcript.done`、`response.done`；
- `error`。

`smart_turn` 判定用户进行了有效插话时，服务端自动取消当前角色响应。客户端收到 `input_audio_buffer.speech_started` 时只进入用户说话状态，不发送 `response.cancel`，避免把“嗯”“啊”等无效附和误当成需要客户端强制取消的插话。只有用户点击手动停止按钮时，客户端才发送 `response.cancel` 并停止当前角色发言。

`input_audio_buffer.speech_stopped.reason` 为 `turn_invalid` 时，本次声音不构成有效轮次：没有活动角色回复则回到 `listening`，原回复仍活动时恢复为 `assistant_speaking`。其他结束原因进入思考状态，等待服务端创建新响应。

默认免提会话使用 `smart_turn`。“按住说话”只通过本地启用/禁用麦克风 RTP track 实现，松开后仍由 `smart_turn` 判断轮次结束。WebRTC 不支持 `turn_detection: null` 或 `input_audio_buffer.commit` 手动模式，界面模式切换不会发送这两种配置或事件。

## 上下文与图片能力

`qwen-audio-3.0-realtime-plus` 最多保留 50 轮、累计 300 秒音频上下文，`max_history_turns` 默认是 20。超过供应商上限后更早内容会被丢弃，因此完整产品仍需保存已确认转写、生成摘要，并在必要时轮换会话。

该模型只支持 Audio 与 Text 输入，不支持图片。当前语音样例也不实现图片；后续拍题流程需要使用 `qwen3.5-omni-plus-realtime` 或独立视觉模型分析图片，再把带来源标记的描述或结构化结果送入语音会话。

## 状态与故障行为

连接状态包括：

```text
idle → requesting_microphone → connecting → configuring → active
                                             active → reconnecting → active
                                                                  ↘ paused
```

浏览器的 WebRTC 栈会先自行恢复短暂断线。连接在 30 秒内没有恢复时，样例进入 `paused`，不会静默切换模型、供应商或声音。

原始 DataChannel 事件最多在页面内保留最近 80 条，用于技术诊断；当前样例不把它们写入数据库。

## 实测清单

建议在安静房间、电视背景声和普通家庭噪声三种条件下，分别用手机和桌面完成同一段脚本：

1. 角色开场是否自然，是否像朗读提示词；
2. 用户说完到角色出声的主观延迟；
3. 连续追问 5 轮是否保持人设和上下文；
4. 在角色说话前段、中段各打断 3 次；
5. “嗯”“对”等附和是否被错误识别为抢话；
6. 扬声器播放时是否发生明显回声或自我打断；
7. 用户和角色字幕是否漏字、重复或在完成时跳变；
8. 免提与按住说话在嘈杂环境中的差异；
9. Audio Plus 与后续 Audio Flash 对照的自然度、延迟及稳定性差异；
10. 切到后台再返回、短暂断网再恢复的行为。

真实模型调用不会进入自动测试，因为它需要个人凭据、会产生云端费用且结果具有随机性。自动测试覆盖协议校验、SDP 安全边界、API 代理和字幕/打断状态投影。

## 当前限制

- WebRTC 是白名单能力，必须配置商务提供的 `QWEN_REALTIME_ENDPOINT`，不能从 Workspace ID 推导；
- 尚未使用真实凭据和白名单 Endpoint 确认当前账号的模型与 Voice 可用性；页面默认 `longanqian`，仍允许输入服务端支持的音色名称；
- 30 秒内依赖浏览器恢复现有 PeerConnection，尚未实现创建替代会话并重放上下文；
- 未采集首音频包、轮次延迟和打断耗时的结构化指标；
- 尚未在 iOS Safari、Android Chrome 和实际国内网络上完成矩阵测试；
- 尚未接入豆包对照组；
- 尚未接入 Omni 或独立视觉分析的图片回退路径；
- 角色开场使用隐藏的 `conversation.item.create` 用户指令配合 `response.create`，仍需真实调用确认不同模型上的表达稳定性。

## 官方资料

- [Qwen-Audio 实时语音对话](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)
- [qwen-audio-3.0-realtime-plus 模型信息](https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-plus)
- [Realtime API 协议支持矩阵](https://help.aliyun.com/zh/model-studio/realtime-api-overview)
- [Realtime API 接入模型与应用](https://help.aliyun.com/zh/model-studio/realtime-connect-model)
- [Realtime API Token 鉴权](https://help.aliyun.com/zh/model-studio/realtime-token-authentication)
- [Qwen-Audio 客户端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-client-events)
- [Qwen-Audio 服务端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-server-events)
