# openclaw-telegram-cn

OpenClaw Telegram 频道插件，专为中国大陆服务器设计。使用 Node.js 原生 `https` 模块调用 Telegram Bot API，完全绕开 OpenClaw 2026.3.x 中 undici 的网络栈/代理/TLS Bug。

## 为什么需要这个插件？

OpenClaw 2026.3.x 将 Telegram 模块的 HTTP 客户端从 Node.js 原生 fetch 切换为 undici。undici 维护自己独立的网络栈和 DNS 解析，导致：

- **绕过系统 hosts 文件**（Issue [#33013](https://github.com/openclaw/openclaw/issues/33013)）
- **覆盖 proxy dispatcher**（Issue [#30338](https://github.com/openclaw/openclaw/issues/30338)）
- **忽略 `NODE_TLS_REJECT_UNAUTHORIZED` 环境变量**
- **忽略 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量**（Issue [#28524](https://github.com/openclaw/openclaw/issues/28524)）
- **SSRF 防护层再次覆盖 proxy dispatcher**（Issue [#44369](https://github.com/openclaw/openclaw/issues/44369)）

这些 Bug 导致在中国大陆通过 SSH 隧道/VPN/代理访问 Telegram API 的架构全部失效。

本插件通过 Node.js 原生 `https.request()` 调用 Telegram API，完全不经过 undici，从根本上绕开所有上述问题。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│ 上海服务器（中国大陆）                                        │
│                                                             │
│  OpenClaw Gateway                                           │
│    └─ telegram-cn 插件                                      │
│        ├─ Long Polling (原生 https.request)                  │
│        ├─ 收到消息 → rt.channel.reply.dispatch → Agent       │
│        └─ Agent 回复 → sendMessage (原生 https.request)      │
│                                                             │
│  /etc/hosts: api.telegram.org → 127.0.0.1                   │
│  SSH 隧道: localhost:443 → 首尔服务器:443                     │
└─────────────────────────────────────────────────────────────┘
                          │ SSH 隧道
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 首尔服务器（海外）                                            │
│                                                             │
│  SNI Proxy (:443)                                           │
│    └─ 读取 TLS ClientHello 的 SNI 字段                      │
│    └─ api.telegram.org → TCP 透传到 Telegram 真实服务器       │
│    └─ 不终结 TLS，证书由 Telegram 直接返回                    │
└─────────────────────────────────────────────────────────────┘
                          │ TCP 透传
                          ▼
              api.telegram.org (Telegram 真实服务器)
```

**如果你的服务器能直接访问 Telegram API（海外服务器），不需要 SSH 隧道和 SNI Proxy，插件同样可以工作。**

## 快速开始

### 1. 安装插件

```bash
# 复制插件到 OpenClaw extensions 目录
cp -r telegram-cn ~/.openclaw/extensions/

# 或者用 git clone
git clone https://github.com/你的仓库/openclaw-telegram-cn.git ~/.openclaw/extensions/telegram-cn
```

### 2. 配置 OpenClaw

```bash
# 禁用内置 Telegram 频道（必须，否则会抢 polling）
openclaw config set channels.telegram.enabled false

# 启用 telegram-cn 插件
openclaw config set channels.telegram-cn.enabled true
openclaw config set channels.telegram-cn.botToken "你的BOT_TOKEN"
openclaw config set channels.telegram-cn.dmPolicy open

# 如果 OpenClaw 报 unknown channel key，加入 allow 列表
openclaw config set plugins.allow '["telegram-cn"]'
```

### 3. 重启 Gateway

```bash
systemctl restart openclaw
# 或
openclaw gateway restart
```

### 4. 验证

```bash
# 查看日志
journalctl -u openclaw -f | grep tgcn

# 期望看到：
# [tgcn] registering...
# [tgcn] botToken: 123456789:...
# [tgcn] routing: OK
# [tgcn] registered
# [tgcn] poller starting
# [tgcn] bot: @YourBotName (123456789)
# [tgcn] polling started
```

在 Telegram 里给你的 bot 发消息，应该能收到 AI 回复。

## 中国大陆网络配置（SSH 隧道 + SNI Proxy）

如果你的服务器在中国大陆，无法直接访问 `api.telegram.org`，需要通过海外服务器中转。

### 海外服务器：部署 SNI Proxy

```bash
# 复制 SNI Proxy 脚本
cp infra/sni-proxy.js /opt/sni-proxy/sni-proxy.js

# 安装 systemd 服务
cp infra/sni-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable sni-proxy
systemctl start sni-proxy

# 验证
systemctl status sni-proxy
ss -tlnp | grep ':443'
```

SNI Proxy 是一个纯 TCP 透传代理，零依赖（只用 Node.js 内置的 `net` 模块）。它读取 TLS ClientHello 中的 SNI 字段做路由，不终结 TLS。

### 国内服务器：配置 hosts + SSH 隧道

**1. 修改 hosts**

```bash
echo "127.0.0.1 api.telegram.org" >> /etc/hosts
```

**2. 建立 SSH 隧道**

```bash
ssh -L 443:127.0.0.1:443 user@海外服务器IP -N -f \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=60 \
  -o ServerAliveCountMax=3
```

推荐用 `autossh` 或 systemd 服务管理隧道，保证断线自动重连。

**autossh 示例：**

```bash
autossh -M 0 -f -N \
  -L 443:127.0.0.1:443 \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=60 \
  -o ServerAliveCountMax=3 \
  user@海外服务器IP
```

**3. 验证链路**

```bash
# 检查证书
openssl s_client -connect 127.0.0.1:443 -servername api.telegram.org 2>/dev/null \
  | openssl x509 -noout -subject -issuer
# 期望：subject=CN = api.telegram.org

# 检查 API
curl -sk https://api.telegram.org/botYOUR_TOKEN/getMe
# 期望：{"ok":true,"result":{...}}
```

## 配置参考

在 `~/.openclaw/openclaw.json` 中：

```json
{
  "channels": {
    "telegram": {
      "enabled": false
    },
    "telegram-cn": {
      "enabled": true,
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "dmPolicy": "open"
    }
  }
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | false | 启用插件 |
| `botToken` | string | — | Telegram Bot Token（必填） |
| `dmPolicy` | string | "open" | DM 策略：open / pairing / allowlist |

也支持环境变量 `TELEGRAM_CN_BOT_TOKEN` 作为 token 的 fallback。

## 插件架构

插件基于 [openclaw-channel-dingtalk](https://github.com/soimy/openclaw-channel-dingtalk) 的架构编写，使用 OpenClaw plugin-sdk 的标准 Channel Plugin 接口。

### 消息处理流程

```
Telegram 用户发消息
    │
    ▼
Long Polling (原生 https.request)
    │
    ▼
rt.channel.routing.resolveAgentRoute()     ← 路由解析
    │
    ▼
rt.channel.session.resolveStorePath()      ← Session 存储
    │
    ▼
rt.channel.reply.formatInboundEnvelope()   ← 构造消息信封
rt.channel.reply.finalizeInboundContext()   ← 构造标准 ctx
    │
    ▼
rt.channel.session.recordInboundSession()  ← 记录 Session
    │
    ▼
rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher()  ← 触发 Agent
    │
    ▼
deliver 回调收到 Agent 回复
    │
    ▼
sendMessage (原生 https.request) → Telegram
```

### 文件结构

```
telegram-cn/
├── src/
│   └── index.ts           # 插件核心代码（单文件）
├── infra/
│   ├── sni-proxy.js       # 海外 SNI Proxy（可选）
│   └── sni-proxy.service  # SNI Proxy systemd 配置
├── package.json           # 插件元数据
├── openclaw.plugin.json   # OpenClaw 插件清单
├── LICENSE
└── README.md
```

## 已知限制

- **仅支持文本消息**：图片、文件等媒体消息暂未实现（TODO）
- **单 Bot 模式**：当前版本不支持多 account，计划在后续版本支持多 bot = 多主题对话
- **typing 状态**：使用定时器每 4 秒发送一次 `sendChatAction("typing")`，不如内置频道丝滑
- **`rejectUnauthorized: false`**：为兼容 SSH 隧道场景禁用了 TLS 证书校验。如果你的服务器能直连 Telegram，可以改为 `true`

## 路线图

- [ ] 媒体消息支持（图片、文件、语音）
- [ ] 多 Bot / 多 Account 支持（多主题对话）
- [ ] Block streaming（流式输出中间结果）
- [ ] 群组消息支持优化（@mention 检测）
- [ ] 从配置文件读取 `rejectUnauthorized` 选项
- [ ] npm 发布

## 相关问题

- [#33013](https://github.com/openclaw/openclaw/issues/33013) — undici 绕过 TUN/VPN
- [#30338](https://github.com/openclaw/openclaw/issues/30338) — applyTelegramNetworkWorkarounds 覆盖 proxy dispatcher
- [#28524](https://github.com/openclaw/openclaw/issues/28524) — Telegram 忽略 HTTP_PROXY
- [#44369](https://github.com/openclaw/openclaw/issues/44369) — SSRF guard 覆盖 proxy dispatcher
- [#4038](https://github.com/openclaw/openclaw/issues/4038) — Telegram Proxy 配置不生效

## 致谢

- [openclaw-channel-dingtalk](https://github.com/soimy/openclaw-channel-dingtalk) — 插件架构参考
- [OpenClaw](https://github.com/openclaw/openclaw) — 核心框架

## License

MIT
