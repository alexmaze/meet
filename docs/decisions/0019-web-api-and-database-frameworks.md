# ADR-0019：Web、API 与数据库框架

- 状态：Accepted
- 日期：2026-08-08

## 决策

1. Web 使用 React、Vite 和 `vite-plugin-pwa`，不采用 SSR 框架。
2. API 使用 Fastify，并按插件划分认证、角色、会话、媒体、供应商、工具与诊断模块。
3. 需要服务端 WebSocket 中继时使用 `@fastify/websocket`；浏览器可安全直连的供应商 WebRTC 不经过 API 转发媒体。
4. PostgreSQL schema、查询和迁移使用 Drizzle ORM。
5. 复杂或性能敏感查询允许使用参数化原生 SQL，不强制所有查询经过 ORM 表达式。
6. Monorepo 使用 pnpm workspace。
7. PWA 新版本采用提示刷新，不在活跃通话中自动重载。

## 理由

- Meet 是登录后的独立 PWA，不需要搜索引擎渲染或服务端页面渲染；
- Fastify 的插件封装和请求生命周期适合隔离认证、实时连接与供应商模块；
- Fastify WebSocket 路由可以复用认证钩子，并在服务关闭时显式清理连接；
- Drizzle 提供类型化 schema 和迁移，同时不阻止直接使用 SQL；
- pnpm workspace 与同级项目保持一致，减少本地工具差异。

## 影响

- Web 与 API 独立运行和构建，通过共享 protocol 包对齐数据结构；
- API 插件不得直接依赖 Web 代码，供应商 SDK 封装放在 realtime 包或 API 插件内；
- 数据库迁移文件进入版本控制并参与自动测试；
- Service Worker 缓存范围必须显式限制，不能缓存私人 API、音频或凭据；
- 依赖的确切版本在初始化项目时依据当前官方兼容性和测试结果锁定。

