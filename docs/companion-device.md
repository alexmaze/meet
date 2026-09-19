# 陪伴设备（伴伴机）

状态：Accepted  
日期：2026-09-19  
关联：[ADR-0038](./decisions/0038-companion-device-pairing.md)、固件方案 `meet_esp32/docs/product-and-architecture.md`

## 产品是什么

陪伴设备是家庭里的 Meet 角色实体，不是浏览器客户端，也不是小智盒子。用户配上网、在网页用 6 位配对码绑定账号，之后按一下就能和 **SelectedCharacter** 打电话式全双工通话。

设备不输入账号密码。身份是 **DeviceCredential**（Bearer），与浏览器 `meet_session` 并存。儿童账号在设备上强制 `chat_only`。空闲约 90 秒 **IdleHangup**。

第一版只做语音。摄像头、MCP 主控、厂商 Opus/MQTT 会话都不做。

## 用户旅程

1. **配网**：设备开 SoftAP（`Meet-XXXX`），手机浏览器填家里 Wi-Fi。
2. **配对**：屏上 6 位码 → 「我的 → 陪伴设备」绑定 → 设备拿到一次性凭证。
3. **待命 / 通话**：显示当前角色；Boot 或唤醒词进入通话；再按或空闲挂断。
4. **设置**：切角色、重新配对、重新配网。重配网保留凭证；重新配对才换账号。

## 和网页的协议对齐

设备走与网页相同的 realtime WebSocket PCM：16 kHz 上行、24 kHz 下行、`session.update`、插话时清播放队列。厂商 Key 不上板。API 见 ADR-0038 与 `/api/devices/*`。

## 阶段

- **P0**：家里能打通一通电话（配网、真麦真喇叭、配对重试、接通态、中文屏）。
- **P1**：唤醒词、AEC、音量/电量、横竖屏。
- **P2**：OTA、弱网、字幕与生产烧录。
