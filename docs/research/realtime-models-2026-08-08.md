# 实时语音模型调研

调研日期：2026-08-08  
最近复核：2026-08-09  
结论用途：Meet 第一版模型选型

模型和价格变化较快，正式开发与上线前必须重新核对官方文档。

## 结论摘要

如果主要在中国大陆使用：

- 纯语音首选验证：`qwen-audio-3.0-realtime-plus`；
- 同系列成本对照：`qwen-audio-3.0-realtime-flash`；
- 图片与教学多模态候选：`qwen3.5-omni-plus-realtime`；
- 最重要的角色表现对照：豆包实时语音 3.0 全双工版本（Seeduplex）；
- OpenAI Realtime 只适合作为具备受支持地区条件时的可选适配器；
- Gemini Live 可作为成本和多语言对照，但不是角色聊天首选；
- ElevenLabs 更适合在后期作为专业克隆音色方案。

这只是验证顺序，不是永久供应商绑定。默认模型仍需通过真实设备、实际国内网络和同脚本盲测确定。

## Qwen-Audio 3.0 Realtime

`qwen-audio-3.0-realtime-plus` 当前最贴合 Meet 的纯语音优先级。官方资料显示：

- 支持 WebRTC、AOQ 和 WebSocket；
- 输入模态为 Audio 与 Text，输出为 Audio 与 Text，不支持图片输入；
- `smart_turn` 融合声学感知与语义理解判断轮次，无意义的“嗯”“啊”等附和不会打断对话；
- 支持 Function Calling、系统音色和声音复刻音色；
- `voice` 默认值为 `longanqian`，目前列出的系统音色共 5 个；
- `max_history_turns` 默认为 20，可设置为 1–50；模型最多保留 50 轮、累计 300 秒音频，超过后丢弃更早历史；
- `turn_detection` 只能在首次发送音频前设置；当前 WebRTC 接入不支持 `turn_detection: null` 或 `input_audio_buffer.commit` 手动模式；
- WebRTC 当前为白名单能力，需要从阿里云商务取得专用 Endpoint，不能根据 Workspace ID 推导。

北京地域公开原价为音频输入 ¥40/百万 token、文本加音频输出 ¥150/百万 token。价格与可用额度可能变化，实测记录应保存供应商用量事件并以当时控制台为准。

`qwen-audio-3.0-realtime-plus` 因此作为首个真实设备验证对象，默认使用 WebRTC、`smart_turn` 和 `longanqian`。界面的按住说话只是本地 RTP 音轨 gate，松开后仍由 `smart_turn` 判断轮次，并不切换成供应商手动提交模式。目前尚未使用真实凭据与白名单 Endpoint 完成手机、桌面与实际国内网络矩阵测试，不能把官方能力描述当作最终质量结论。

官方资料：

- <https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides>
- <https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-realtime-plus>
- <https://help.aliyun.com/zh/model-studio/realtime-api-overview>
- <https://help.aliyun.com/zh/model-studio/realtime-connect-model>
- <https://help.aliyun.com/zh/model-studio/realtime-token-authentication>

## Qwen3.5 Omni Realtime

Qwen3.5 Omni Plus Realtime 不再是纯语音首选验证模型，但继续承担图片、拍题和教学多模态候选。官方模型信息显示其输入支持 Text、Image、Video 与 Audio；这正是 Qwen-Audio 缺失的能力。另一条可行路径是使用独立视觉模型分析图片，再把描述或结构化结果注入 Qwen-Audio 会话，两条路径都需要真实拍题脚本比较延迟、准确性和上下文连续性。

官方资料显示其支持：

- WebRTC 和 WebSocket；
- 语义打断；
- 通过自然语言控制音量、语速和情绪；
- 55 个预设音色；
- 113 种语言或方言识别、36 种语言或方言输出；
- Plus 和 Flash 实时模型直接使用克隆音色；
- 北京和新加坡接入区域。

北京地域公开价格：

| 模型 | 音频输入 | 音频输出 | 双方各说 30 秒的新增音频理论费用 |
|---|---:|---:|---:|
| Plus | ¥80/百万 token | ¥300/百万 token | 约 ¥0.129/分钟 |
| Flash | ¥27/百万 token | ¥107/百万 token | 约 ¥0.046/分钟 |

理论费用不包含文本 token，也没有计入长对话反复处理历史上下文的费用。

官方资料：

- <https://help.aliyun.com/zh/model-studio/realtime>
- <https://help.aliyun.com/en/model-studio/model-pricing>

## 豆包实时语音

早期调研使用 `S2S-SC` 名称。当前接入对象已经更新为豆包实时语音 3.0 全双工版本（Seeduplex），使用固定模型版本 `1.2.6.1` 和标准化 Realtime JSON 事件协议。它仍直接面向低延迟、角色感与自然语音交互，实际体验需要在目标网络和设备上测量。

优势：

- 中文角色和情绪表达是重点能力；
- 支持实时打断；
- 提供公共音色与声音复刻；
- 明确覆盖儿童和情感陪伴场景。

不确定项：

- 公开价格不如千问透明；
- 新全双工协议的生产权限、并发时长额度和 `extension` 专有配置仍需通过真实账号验证；
- 官方效果描述不能代替盲听测试。

官方资料：

- <https://www.volcengine.com/product/realtime-voice-model>
- <https://www.volcengine.com/docs/6561/1594360?lang=zh>
- <https://www.volcengine.com/docs/6561/1594356?lang=zh>
- <https://docs.volcengine.com/docs/6561/2549778?lang=zh>
- <https://docs.volcengine.com/docs/6561/2549732?lang=zh>

## OpenAI GPT-Realtime

`gpt-realtime-2.1` 和 Mini 版本支持 WebRTC、WebSocket、语义 VAD、实时打断和工具调用。

按用户和角色各说 30 秒估算，忽略历史上下文和文本：

- GPT-Realtime 2.1 新增音频理论费用约 $0.048/分钟；
- GPT-Realtime 2.1 Mini 约 $0.015/分钟。

自定义声音可以用于 Realtime，但当前只向符合条件的客户开放。中国大陆和香港不在官方支持地区列表内，因此不能作为大陆个人部署的唯一后端。

官方资料：

- <https://developers.openai.com/api/docs/models/gpt-realtime-2.1>
- <https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini>
- <https://developers.openai.com/api/docs/guides/realtime-webrtc>
- <https://developers.openai.com/api/docs/guides/realtime-vad>
- <https://developers.openai.com/api/docs/guides/text-to-speech>
- <https://developers.openai.com/api/docs/supported-countries>

## Google Gemini Live

`gemini-3.1-flash-live-preview` 支持中文、多语言切换、自动 VAD 和打断。音频输入约 $0.005/分钟、输出约 $0.018/分钟；双方各说 30 秒时，新增音频理论费用约 $0.0115/分钟。

限制与风险：

- 当前模型是 Preview；
- 纯音频会话默认有 15 分钟限制，需要会话续接；
- 当前 3.1 不提供上一代模型列出的 affective dialogue；
- 中国大陆不在官方可用地区列表内；
- 未找到可作为稳定产品依赖的 Live API 原生声音克隆能力。

官方资料：

- <https://ai.google.dev/gemini-api/docs/live-api/capabilities>
- <https://ai.google.dev/gemini-api/docs/live-api/best-practices>
- <https://ai.google.dev/gemini-api/docs/pricing>
- <https://ai.google.dev/gemini-api/docs/available-regions>

## ElevenLabs

ElevenLabs 提供即时声音克隆、专业声音克隆、Voice Design、多语言声音以及基于 WebRTC 的 Agent SDK。它更适合在项目后期解决高质量克隆音色问题，而不是第一版的主对话模型。

公开 Agent 价格中，部分套餐的额外用量约 $0.08/分钟，模型费用另计。

官方资料：

- <https://elevenlabs.io/docs/overview/capabilities/voices>
- <https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning>
- <https://elevenlabs.io/docs/eleven-agents/libraries/java-script>
- <https://elevenlabs.io/pricing/agents>

## 统一盲测建议

每个候选模型使用相同角色提示词、相同设备和相同网络，至少测试：

1. 正常问答和连续追问；
2. 角色说到一半时快速插话；
3. 用户停顿、犹豫和只说“嗯”；
4. 笑、叹气、轻声和情绪变化；
5. 一次多步数学讲解；
6. 儿童含糊表达和口语化中文；
7. 诱导角色偏离身份；
8. 20 分钟长对话后的记忆与人设；
9. Wi-Fi 抖动和短暂断网；
10. 同一内容不同预设音色的表现。

盲测前隐藏供应商名称，以自然度、情绪、人设、插话、延迟和成本六个维度评分。
