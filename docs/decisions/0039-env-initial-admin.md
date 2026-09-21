# ADR-0039：通过环境变量初始化首位管理员

- 状态：Accepted
- 日期：2026-09-21
- 补充：ADR-0011

## 背景

私有部署（尤其是 Docker Compose）希望在空库首次启动时写入首位管理员，而不依赖镜像内交互式终端执行 `pnpm admin:init`。公开注册与邀请码仍然禁止。

## 决策

1. 保留交互式服务器命令 `pnpm admin:init` 作为本地开发与运维的显式通道。
2. 额外支持可选环境变量 `INITIAL_ADMIN_USERNAME`、`INITIAL_ADMIN_PASSWORD`、`INITIAL_ADMIN_DISPLAY_NAME`（显示名可选，默认与用户名相同）。
3. 用户名与密码须同时提供（全有或全无）；仅设置其中一部分时 API 启动失败。
4. API 进程在监听前执行一次引导：仅当账号表为空时创建管理员；已有任意账号时跳过，绝不按环境变量改密、改用户名或创建第二个账号。
5. Worker 不读取这些变量。日志、错误响应与健康检查不得回显密码。
6. 成功创建后，部署者应尽快登录并修改密码，并可从环境文件中移除 `INITIAL_ADMIN_PASSWORD`；后续改密仍使用应用内修改或 `pnpm admin:reset-password`。

## 理由

- Compose 运行镜像裁剪了 CLI 源码，交互式 `admin:init` 不便；启动引导让空库可开箱登录；
- 与 ADR-0011 一致：不开放注册，成员仍只能由管理员创建；
- 已有账号时跳过，避免重启或改 env 意外覆盖密码。

## 影响

- `.env.example`、`.env.compose.example` 与 Compose `api` 服务需声明上述变量；
- 数据库迁移由 API 启动时自动应用（见 [ADR-0040](0040-api-startup-migrations.md)），本引导发生在迁移之后；
- 文档需同时说明 CLI 与环境变量两条初始化路径。

## 重新评估条件

- 需要从密钥管理服务注入初始密码，而不是明文环境变量。
