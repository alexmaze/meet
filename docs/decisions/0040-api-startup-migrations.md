# ADR-0040：API 启动时自动应用数据库迁移

- 状态：Accepted
- 日期：2026-09-21
- 补充：ADR-0015、ADR-0039

## 背景

Compose 运行镜像不包含交互式开发工具。部署机往往只有 Docker，没有 Node/pnpm。若迁移必须在宿主机执行 `pnpm db:migrate`，私有部署无法只靠镜像完成首次安装和升级。

## 决策

1. API 进程在监听前，用 `drizzle-orm` 的 `migrate()` 应用 `packages/database/migrations`，不依赖镜像内的 `drizzle-kit` 或 TypeScript 源码。
2. 迁移使用 PostgreSQL advisory lock，避免多个 API 副本并发执行。
3. Worker 不执行迁移；Compose 中 Worker 等待 API 健康检查通过后再启动。
4. 本地仍保留 `pnpm db:migrate`，用于不启动 API 时显式应用迁移，或生成新迁移。
5. 教学 Spike 专用库仍按 ADR-0034 手动迁移，不走本路径。

## 理由

- 部署机不应要求安装 pnpm；镜像已包含编译产物和 SQL 迁移文件；
- 只在 API 启动时迁移，健康检查通过后再起 Worker，避免未就绪 schema 上跑后台任务；
- Drizzle 迁移器幂等，重复启动只会跳过已应用版本。

## 影响

- Compose 部署只需准备 `.env.compose` 后 `docker compose up -d`，不再需要宿主机 Node；
- 升级时先做数据库与媒体快照，再拉取新镜像并重启；API 启动时应用新迁移；
- ADR-0039 的环境变量首位管理员在迁移成功后执行。

## 重新评估条件

- 需要独立 migrate Job 或蓝绿发布中先迁移再切流量；
- 需要在启动时关闭自动迁移。
