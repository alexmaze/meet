# ADR-0028：接入豆包实时语音 3.0 全双工 Provider

- 状态：Accepted
- 日期：2026-08-12
- 修订：ADR-0001 中豆包 `S2S-SC` 对照模型的具体接入协议

说明：ADR-0029 将第 2、3、10 项中的固定模型、环境变量凭据和静态 Profile 配置改为管理员维护、测试后启用的数据库配置；豆包协议、音频规格与适配器隔离边界继续有效。

## 背景

ADR-0001 已确定使用豆包实时语音作为中文角色感与情绪表现的对照组。项目早期调研使用 `S2S-SC` 名称和旧版协议；火山引擎在 2026-08-07 更新了“端到端实时语音-全双工版本”，模型称为 Seeduplex，并提供标准化 Realtime JSON 事件协议。

当前默认千问链路已经具备 16 kHz PCM 麦克风采集、24 kHz PCM 可清空播放、同源 Fastify WebSocket 中继、字幕持久化和约 30 秒替代会话恢复。新豆包协议的音频规格与这些基础能力一致，可以通过 Provider Adapter 接入，而不需要重写通话页面或浏览器音频层。

## 决策

1. 豆包接入使用最新全双工接口 `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，不新增旧版 S2S 二进制协议实现。
2. 使用固定模型版本 `1.2.6.1`。浏览器不能覆盖模型、上游地址、角色指令或音色。
3. 浏览器连接 Meet 的同源、带账号认证 WebSocket；API 使用服务端 `X-Api-Key` 连接豆包，不向浏览器下发长期密钥。
4. 第一阶段使用 16 kHz 单声道 PCM16 输入和 24 kHz 单声道 PCM16 输出；输入保持每包约 20 ms。暂不启用 speech_opus 或 OGG-Opus。
5. 服务端构造 `session.create`，把角色 Prompt、有界关系摘要和已确认最近对话编译到最多 12,000 字符的 `instructions`。应用数据库继续是历史、摘要和长期记忆的事实来源。
6. 豆包链路支持 `hands_free` 和 `push_to_talk`。PTT 松开时发送 `input_audio_buffer.commit`；有效用户语音开始或手动停止时立即清空应用 PCM 队列，并按需发送 `response.cancel`。
7. 稳定用户字幕使用 `conversation.item.input_audio_transcription.completed`，角色字幕使用 `response.output_text.*` 与 `response.output_audio.done` 收口；仍使用应用稳定消息 ID 与单调序号幂等保存。
8. 正常结束先发送 `session.close`，在收到 `session.closed` 或有限等待超时后再关闭本地连接。
9. 网络异常继续遵循 ADR-0017：30 秒内只重连同一豆包模型和同一声音。当前先创建替代供应商会话并注入应用确认上下文，不在恢复过程中切换供应商。
10. 新增独立豆包 Provider Profile 和四个全双工音色：Vivi、小何、云舟、小天。千问仍是三个预置角色和新建角色的默认 Provider。
11. 豆包当前声明 `audioInput: true`、`textInput: true`、`imageInput: false`。图片仍经过独立视觉分析回退，不从实时音频会话发送。
12. 豆包与千问必须使用同脚本、同设备、同网络进行盲测；没有新的 ADR，不更换第一版默认 Provider。

## 安全与错误边界

- API 只转发允许列表内的 JSON 文本事件，拒绝浏览器发送 `session.create`、任意配置或二进制帧；
- 限制单帧大小、音频发送速率、控制事件速率、待发送缓存和单连接最长时间；
- API Key、完整音频 Base64 与完整角色 Prompt 不进入常规日志；
- 鉴权和参数类错误停止自动重试，网络或供应商 5xx 错误进入现有恢复流程；
- 保存供应商事件 ID，并在后续诊断补充 `X-Tt-Logid` 关联，但不把它作为业务消息主键。

## 暂不纳入本次接入

- 克隆音色训练和授权管理；
- 豆包专有联网搜索、唱歌或其他 `extension` 能力；
- 持续摄像头或直接图片输入；
- 自动修改三个预置角色的 Provider；
- 在通话故障时静默切换到千问。

## 官方资料

- [端到端实时语音-全双工版本](https://docs.volcengine.com/docs/6561/2549778?lang=zh)
- [全双工版本接入必读](https://docs.volcengine.com/docs/6561/2549732?lang=zh)
- [豆包语音音色列表](https://www.volcengine.com/docs/6561/1257544?lang=zh)

## 重新评估条件

- 官方修改固定模型版本、鉴权方式、事件结构或音频规格；
- 真实设备验证表明 `session.create` 中的 PCM 输出配置与生产权限不兼容；
- 需要直接恢复供应商 `session.id`，且其隐私、生命周期和失败语义已经实测明确；
- 盲测结果支持修改默认 Provider；
- 豆包并发时长额度或实际成本不适合家庭部署。
