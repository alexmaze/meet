# ADR-0020：运行时校验、后台任务与媒体存储

- 状态：Accepted
- 日期：2026-08-08

## 决策

1. Web/API 共享协议使用 Zod 作为运行时 schema 的事实来源，并从 schema 推导 TypeScript 类型。
2. 后台任务使用 `pg-boss` 与已有 PostgreSQL，不引入 Redis。
3. 第一版建立独立 Worker 进程，处理摘要、记忆提取、临时媒体清理和 AI 头像生成。
4. 所有任务 payload 使用 Zod 校验并带业务幂等键；任务允许重试，最终失败进入可诊断状态。
5. 第一版不引入额外的队列管理 Dashboard。
6. 所有媒体操作经过统一 MediaStore。
7. MediaStore 提供本地目录默认实现和 S3 兼容实现，业务层只使用不透明对象 key。

## 理由

- Zod 与同级项目保持一致，也能让 Web、API、实时事件和任务共享同一运行时结构；
- `pg-boss` 利用 PostgreSQL 的队列锁能力，支持可靠重试、定时任务与并发控制，无需增加 Redis 运维；
- 独立 Worker 避免摘要和媒体任务阻塞 API 与实时会话；
- MediaStore 允许项目所有者自由选择本地磁盘或对象存储，而不把部署差异扩散到业务代码。

## 影响

- Monorepo 增加 jobs 与 media 共享包，并正式包含 Worker 应用；
- API 业务事务与任务入队需要保证一致性，任务处理器必须幂等；
- 数据库需要保存任务关联、媒体元数据和补偿清理状态；
- 私人媒体不能依赖永久公开 URL，读取必须经过授权或短期访问机制；
- `pg-boss` 和 PostgreSQL 的确切兼容版本在初始化时依据官方要求锁定。

