# ADR-0034：允许逐次显式使用现有应用数据库执行 Live Spike

- 状态：Accepted
- 日期：2026-08-15

## 背景

ADR-0033 要求真实 Provider 能力验证与产品对话链路隔离。最初实现进一步要求使用空的独立测试数据库，并扫描账号、角色、会话、消息、媒体、任务和记忆表确认没有业务数据。

家庭私有部署环境已经在现有 PostgreSQL 中维护经过验证的模型、连接、音色和 API Key。为一次小样本协议冒烟重新复制这些配置会增加配置漂移和密钥复制风险，因此项目所有者决定允许直接使用现有应用数据库完成验证。

这项决定只改变 Spike 的存储位置，不授权读取家庭成员内容，也不改变 Provider 付费确认、能力晋级或产品教学开关边界。

## 决策

1. 默认模式继续使用 `TEACHING_SPIKE_DATABASE_URL` 指向的独立测试数据库，并保留现有空库隔离审计。
2. 只有每次命令显式提供 `--use-application-database` 时，Qwen live CLI 才使用 `DATABASE_URL`。该参数不是持久环境开关，preflight 和 execute 都必须分别提供。
3. 数据库作用域写入不可变目标并进入 `planHash`。preflight 与 execute 的作用域不同、连接主体不同或数据库指纹不同都失败关闭。
4. 现有应用数据库模式不查询账号、角色、家庭资料、会话、消息、摘要、记忆、媒体或任务表，也不执行空库扫描。允许读取的业务配置仅限：
   - 精确 UUID、修订、Provider、模型和声音约束的 `provider_profiles`、`model_connections`、`voice_profiles`；
   - preflight 不选择 API Key；一次性授权消费成功且目标仍完全一致后才读取对应连接的 API Key；
   - 数据库可信时钟。
5. 两种模式唯一允许写入的表都是 `teaching_spike_live_authorizations`。Spike 不写 Conversation、Message、Memory、角色、模型配置或能力声明。
6. CLI 不自动迁移数据库。现有应用数据库通过普通 `pnpm db:migrate` 应用迁移；`pnpm db:migrate:teaching-spike` 继续只允许独立测试数据库，不能用同库参数绕过。
7. 真实 Provider 调用仍要求 `--live`、`--execute`、原 `runId`、完整 `planHash` 和交互式终端逐字二次确认；预算、用例数量、一次性消费、脱敏报告和 `not_evaluated` 结论保持不变。

## 结果

- 可以复用现有数据库中已经测试启用的模型配置和凭据，无需复制密钥。
- preflight 会在现有数据库新增一条最多 10 分钟有效的专用授权记录，但不会连接 Provider 或产生模型费用。
- 现有数据库比独立测试数据库具有更高的误操作影响，因此同库参数必须逐次显式出现，查询与写入允许列表必须持续由测试保护。
- 若未来需要把 Spike 变成产品内诊断能力，必须另行决策权限、审计、数据保留和 UI；本 ADR 不授权增加 HTTP/WS 路由。

