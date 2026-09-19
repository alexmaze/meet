# ADR-0038：陪伴设备配对与设备凭证

- 状态：Accepted
- 日期：2026-09-14
- 补充：ADR-0011
- 产品方案：`docs/companion-device.md`；固件整机方案见独立仓库 `meet_esp32/docs/product-and-architecture.md`

## 背景

Meet 需要把家庭账号绑定到实体陪伴设备（如 ESP32）。浏览器继续用 `meet_session` Cookie；设备不能依赖浏览器 Cookie 与 Origin，需要独立、可撤销的长期凭证，以及短时配对码完成账号绑定。

## 决策

1. **配对码绑定**：设备先创建配对会话，得到 6 位数字配对码（约 5 分钟 TTL）。已登录家庭成员在浏览器输入配对码完成绑定。
2. **DeviceCredential 与浏览器会话分离**：设备使用独立的 `DeviceCredential`（Bearer Token），不写入、不替代 `meet_session` Cookie。同一账号可同时保持浏览器会话与一台或多台设备凭证。
3. **设备 WebSocket Origin**：经 Bearer `DeviceCredential` 认证的设备实时连接跳过 Origin 校验；浏览器 Cookie 会话仍沿用既有 Origin 检查。
4. **儿童设备教学默认**：儿童账号在设备侧发起教学准备时，默认（并强制）为 `chat_only`，避免陪伴设备误开学习小支线。
5. **绑定基数**：同一账号可绑定多台设备；一台设备同一时刻只绑定一个账号。重新绑定会撤销该设备上旧的 DeviceCredential，并按新账号签发新凭证。
6. **一次性交付**：配对会话 claim 后，明文 DeviceCredential 仅在设备首次成功轮询配对状态时返回一次，随后清除。

## 理由

- 私有家庭部署下，短时数字码比邀请链接更适合当面配对；
- Cookie 与设备凭证分离，避免平板共用会话与设备长期凭证互相干扰；
- 设备固件通常无浏览器 Origin；跳过 Origin 必须以有效 DeviceCredential 为前提；
- 儿童设备默认只聊天，降低误触教学流程的风险。

## 影响

- 新增 `companion_devices`、`device_pairing_sessions`、`device_credentials` 表与 `/api/devices/*` 路由；
- HTTP/WebSocket 认证可接受 Cookie 会话或 Bearer DeviceCredential（优先 Cookie）；
- ADR-0011「一台设备同时只保持一个账号的登录状态」仍适用于**浏览器会话**；陪伴设备凭证与浏览器会话可共存，详见对本 ADR 的引用修订。

## 重新评估条件

- 需要远程解绑推送、设备证明（attestation）或多因素配对；
- 设备凭证需要刷新轮换或更短 TTL。
