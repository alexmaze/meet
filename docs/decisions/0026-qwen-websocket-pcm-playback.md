# ADR-0026：Qwen WebSocket PCM 中继与可确定清空的打断播放

- 状态：Accepted
- 日期：2026-08-10
- 修订：ADR-0023、ADR-0024、ADR-0025 中 Qwen-Audio 默认传输与播放实现

## 背景

Qwen-Audio 的浏览器 WebRTC 链路已经能够完成持续通话、`smart_turn`、字幕和语义打断，但真机反复测试暴露了不能由现有实现消除的播放错位：打断后字幕已经进入新响应，扬声器仍可能继续播放旧响应的后续音频。

原因不是字幕状态机本身，而是 WebRTC 的控制事件与媒体播放边界不同。`response.created`、`response.audio_transcript.delta` 等事件经 DataChannel 到达，音频则由独立的 RTP 接收、抖动缓冲和媒体播放管线输出。浏览器没有提供按 Qwen `response_id` 查看或清空 `RTCRtpReceiver` 已缓冲音频的接口。断开 `<audio>`、克隆远端音轨、静音 drain 或等待新字幕后再接回，都只能改变是否放音，不能证明接回时读取到的第一个采样已经属于新响应。

Qwen-Audio 的 WebSocket 协议会把输出音频作为带 `response_id` 的 `response.audio.delta` PCM 数据返回。由应用持有 PCM 播放队列后，打断可以同步清空尚未播放的数据，并按响应标识拒绝迟到的旧分片，从而把字幕状态与可听音频放在同一个可验证的响应边界上。

## 决策

1. 第一版 Qwen-Audio 通话的默认传输从浏览器直连 WebRTC 改为 WebSocket PCM：浏览器连接同源 Fastify WebSocket，中继再连接供应商 WebSocket。`qwen-audio-3.0-realtime-plus`、`smart_turn`、角色音色和 Provider Adapter 边界不变。
2. Fastify 中继持有供应商长期凭据并完成上游鉴权。浏览器不得获得 DashScope API Key，也不得提交任意上游 URL、模型或声音来绕过服务端允许列表。浏览器到中继的连接必须复用账号认证，并校验 Origin、账号对角色的访问权和会话配置。
3. 中继只转发适配器允许的实时事件，并为帧大小、发送速率、上游积压和会话时长设置边界。包含 Base64 PCM 的事件、鉴权头和完整角色提示词不得写入常规日志；浏览器断开、登出或鉴权失效时必须关闭对应上游连接。
4. 浏览器把麦克风音频转换为供应商要求的 PCM16 单声道分片，通过 `input_audio_buffer.append` 发送；当前协议为输入 16 kHz、输出 24 kHz。采样率、分片大小和重采样实现属于 Qwen Provider Adapter，不进入角色、会话或记忆数据模型。免提仍由 `smart_turn` 判断轮次；按住说话模式只控制是否继续发送本地 PCM 分片。
5. 浏览器通过受控的 Web Audio 播放器消费 `response.audio.delta`。每个排队分片必须记录 `response_id` 和本地播放 generation；不得把 Base64 PCM 直接交给不可清空的媒体元素缓冲。
6. 收到 `input_audio_buffer.speech_started` 或用户点击手动停止时，播放器必须先原子增加 generation、清空待解码和待播放队列、停止当前及已安排的旧音频节点，再更新界面状态。这个本地静音边界不等待 `response.cancel` 或 `response.done`。
7. 清空后到达的旧 generation 或已放弃 `response_id` 的 `response.audio.delta` 必须丢弃。只有状态机明确接受的当前响应才能进入新 generation；字幕也按同一响应标识投影。`turn_invalid` 可以允许同一响应之后新到达的分片继续播放，但已清掉的旧音频不回填，也不得重放。
8. 供应商仍可通过 `smart_turn` 自动取消有效插话对应的旧响应。客户端显式 `response.cancel` 继续用于手动停止或适配器明确需要的取消场景；无论上游是否及时停止生成，本地队列清空都是阻止旧语音再次出现的最终边界。
9. 现有 WebRTC 实现保留为实验、诊断或受控回退路径，便于比较端到端延迟和回声处理，但不再是 Qwen-Audio 的默认播放路径，也不能作为“确定性打断”验收实现。启用它时必须明确暴露该限制，不能静默回退。
10. 原始语音保留策略不因中继而改变。服务端默认只转发实时 PCM，不持久化；按次录音仍必须经过现有录音授权和 MediaStore 边界。

## 理由

- 带 `response_id` 的应用层 PCM 分片可以被测试、计数和拒绝，RTP 接收缓冲中的采样不能；
- 清空应用持有的队列是同步本地操作，不依赖字幕与 RTP 的跨通道先后关系，也不依赖供应商取消事件的网络延迟；
- 服务端中继保留长期密钥和供应商允许列表，满足凭据不得进入浏览器的既有安全约束；
- WebRTC 仍可用于性能对照，但不能用启发式静音间隔替代可证明的响应边界。

## 取舍

- 音频多经过一次家庭部署服务器，会增加带宽、少量延迟和连接容量压力；中继需要背压、限流、超时和断线清理；
- 浏览器需要 PCM 采集、重采样和 AudioWorklet/等价可清空播放器，开发与跨浏览器测试成本高于直接播放远端 MediaStream；
- WebSocket 不提供 WebRTC 媒体栈的完整回声消除保障。仍应请求浏览器麦克风的 `echoCancellation`、`noiseSuppression` 和 `autoGainControl`，并在外放场景做真机验证；无法达到可接受效果时应显式暂停或选择另一适配器，而不是牺牲打断正确性；
- 断线恢复只能恢复已确认的文本和业务记录，不能重放中断前尚未播放的旧 PCM；这是避免重复语音的有意选择。

## 验收与回归

1. 自动化测试必须覆盖：清队列后迟到的旧 `response_id` 分片被丢弃；旧 `response.done` 不关闭新响应；`turn_invalid` 只允许之后的新分片继续；手动停止在无活动上游响应时仍立即清空本地音频。
2. 调试指标至少记录不含 PCM 内容的 `response_id`、generation、入队/丢弃分片数、队列时长、打断到本地静音的耗时和断线原因。任一次打断后出现旧 generation 的可听分片即为失败。
3. 真机矩阵至少覆盖 iOS Safari、Android Chrome、桌面 Chrome/Safari，分别使用外放和耳机，并覆盖安静环境、家庭背景声、连续长回复中插话、短附和被判无效、快速连续两次打断、切后台再返回及短时断网恢复。
4. 每个核心设备与输出组合应连续执行不少于 20 次有效打断；字幕与首个恢复播放的 PCM 必须属于同一已接受响应，旧回复不得在打断后再次发声。同时记录外放回声是否导致自激输入、漏判或误判。

## 对既有决策的影响

- ADR-0023 的 WebRTC 握手样例保留为实验路径，其“浏览器直连媒体”的实现不再代表默认 Qwen-Audio 通话；
- ADR-0024 第 2、3、9 项的 WebRTC 传输与本地 RTP gate 改由本决策修订，第 10 项改为“供应商取消与本地 PCM 清空相互独立”；模型能力、`smart_turn`、上下文上限、图片能力路由与密钥安全边界继续有效；
- ADR-0025 第 2 项中“沿用 WebRTC”的部分改为默认 WebSocket PCM 中继，其余业务开发、默认模型与 Provider Adapter 决策继续有效。

## 官方依据

- [Qwen-Audio 实时语音对话](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)
- [Qwen-Audio Realtime 客户端事件](https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events)
- [Qwen-Audio Realtime 服务端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-server-events)
- [Realtime API 协议支持矩阵](https://help.aliyun.com/zh/model-studio/realtime-api-overview)
- [Realtime API Token 鉴权](https://help.aliyun.com/zh/model-studio/realtime-token-authentication)
