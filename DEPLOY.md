# TelegramCN 全量部署指令

**执行纪律：严格按照步骤顺序执行，每一步执行完毕后将完整输出贴回来。不要自行判断问题原因，不要自行尝试修复，不要跳步，不要发散。你的角色是执行和汇报，不是诊断和决策。**

你运行在**首尔1814服务器**上，通过 SSH 操作**上海母机（上海95）**。

上海母机已安装好 OpenClaw，需要从零配置以下内容：
1. 首尔 SNI Proxy 确认
2. 上海 hosts 劫持
3. SSH 隧道
4. 链路验证
5. TelegramCN 插件安装
6. OpenClaw 配置
7. 启动验证
8. 消息测试

---

## 第一步：确认首尔 SNI Proxy 在跑

在首尔本机（不用 SSH）执行：

```bash
systemctl status sni-proxy 2>&1 | head -10
ss -tlnp | grep ':443'
```

如果没在跑：
```bash
systemctl start sni-proxy
```

贴回输出。

---

## 第二步：配置上海母机 hosts

```bash
ssh 上海母机 "grep -q 'api.telegram.org' /etc/hosts && echo 'EXISTS' || (echo '127.0.0.1 api.telegram.org' >> /etc/hosts && echo 'ADDED')"
ssh 上海母机 "cat /etc/hosts | grep telegram"
```

贴回输出。确认 `127.0.0.1 api.telegram.org` 存在。

---

## 第三步：建立 SSH 隧道

先检查有没有已有的隧道：

```bash
ssh 上海母机 "ss -tlnp | grep ':443'"
```

如果 443 没有被监听，建立隧道（将 `root@首尔1814的IP` 替换为实际连接信息）：

```bash
ssh 上海母机 "ssh -L 443:127.0.0.1:443 root@首尔1814的IP -N -f -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -o ServerAliveCountMax=3"
```

确认：
```bash
ssh 上海母机 "ss -tlnp | grep ':443'"
```

贴回输出。

---

## 第四步：验证链路

```bash
ssh 上海母机 "openssl s_client -connect 127.0.0.1:443 -servername api.telegram.org 2>/dev/null | openssl x509 -noout -subject -issuer"
```

期望：`subject=CN = api.telegram.org`

```bash
ssh 上海母机 "curl -sk https://api.telegram.org/bot8752096053:AAHoizRI7cee8cVq0au5PKV-Ffir1p5ggM4/getMe 2>&1"
```

期望：`{"ok":true,"result":{"id":8752096053,...}}`

贴回输出。

---

## 第五步：禁用内置 Telegram 频道

```bash
ssh 上海母机 "openclaw config set channels.telegram.enabled false 2>&1"
```

贴回输出。

---

## 第六步：创建插件目录和文件

### 6.1 创建目录

```bash
ssh 上海母机 "mkdir -p ~/.openclaw/extensions/telegram-cn/src"
```

### 6.2 创建 package.json

```bash
cat << 'EOF' | ssh 上海母机 "cat > ~/.openclaw/extensions/telegram-cn/package.json"
{
  "name": "telegram-cn",
  "version": "1.0.0",
  "description": "Telegram channel for China - native https, bypasses undici",
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "channel": {
      "id": "telegram-cn",
      "label": "Telegram CN",
      "selectionLabel": "Telegram CN (native https)",
      "blurb": "Telegram Bot via native Node.js https — no undici.",
      "aliases": ["tgcn"]
    }
  }
}
EOF
```

### 6.3 创建 openclaw.plugin.json

```bash
cat << 'EOF' | ssh 上海母机 "cat > ~/.openclaw/extensions/telegram-cn/openclaw.plugin.json"
{
  "id": "telegram-cn",
  "name": "Telegram CN",
  "version": "1.0.0",
  "description": "Telegram channel using native Node.js https",
  "channels": ["telegram-cn"]
}
EOF
```

### 6.4 创建 src/index.ts

```bash
cat << 'PLUGINEOF' | ssh 上海母机 "cat > ~/.openclaw/extensions/telegram-cn/src/index.ts"
import * as https from "node:https";

const POLL_TIMEOUT = 10;
const RETRY_DELAY = 5000;
const CHANNEL_ID = "telegram-cn";
const MAX_MSG_LEN = 4000;

let rt: any = null;
let cfg: any = null;
let log: any = console;
let BOT_TOKEN = "";
let API_BASE = "";

function getBotToken(): string {
  if (BOT_TOKEN) return BOT_TOKEN;
  const channels = (cfg as any)?.channels;
  const tgcn = channels?.["telegram-cn"] || channels?.telegramCn;
  BOT_TOKEN = tgcn?.botToken || process.env.TELEGRAM_CN_BOT_TOKEN || "";
  API_BASE = \`https://api.telegram.org/bot\${BOT_TOKEN}\`;
  if (!BOT_TOKEN) log.error("[tgcn] botToken not found in config or env!");
  return BOT_TOKEN;
}

function tgApi(method: string, body?: any): Promise<any> {
  getBotToken();
  if (!BOT_TOKEN) return Promise.reject(new Error("No bot token configured"));
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const url = new URL(\`\${API_BASE}/\${method}\`);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname,
      method: payload ? "POST" : "GET",
      rejectUnauthorized: false,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.ok) resolve(j.result); else reject(new Error(\`TG [\${method}]: \${j.description || data}\`));
        } catch { reject(new Error(\`TG parse: \${data.substring(0, 200)}\`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout((POLL_TIMEOUT + 15) * 1000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function sendTyping(chatId: number | string) {
  try { await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }); } catch {}
}

async function sendTgMessage(chatId: number | string, text: string, replyTo?: number) {
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= MAX_MSG_LEN) { chunks.push(rem); break; }
    let c = rem.lastIndexOf("\\n", MAX_MSG_LEN);
    if (c < MAX_MSG_LEN * 0.5) c = MAX_MSG_LEN;
    chunks.push(rem.substring(0, c));
    rem = rem.substring(c);
  }
  for (let i = 0; i < chunks.length; i++) {
    const b: any = { chat_id: chatId, text: chunks[i], parse_mode: "HTML" };
    if (i === 0 && replyTo) b.reply_parameters = { message_id: replyTo };
    try { await tgApi("sendMessage", b); } catch (e: any) {
      if (e.message?.includes("parse")) { delete b.parse_mode; await tgApi("sendMessage", b); } else throw e;
    }
  }
}

let pollingActive = false;
let lastOffset = 0;

async function startPolling(onMsg: (u: any) => Promise<void>) {
  pollingActive = true;
  try { await tgApi("deleteWebhook", { drop_pending_updates: false }); } catch {}
  try {
    const me = await tgApi("getMe");
    log.info(\`[tgcn] bot: @\${me.username} (\${me.id})\`);
  } catch (e: any) { log.error(\`[tgcn] getMe failed: \${e.message}\`); return; }
  log.info("[tgcn] polling started");
  while (pollingActive) {
    try {
      const updates = await tgApi("getUpdates", { offset: lastOffset, timeout: POLL_TIMEOUT, allowed_updates: ["message"] });
      if (Array.isArray(updates)) for (const u of updates) {
        lastOffset = u.update_id + 1;
        try { await onMsg(u); } catch (e: any) { log.error(\`[tgcn] handler: \${e.message}\`); }
      }
    } catch (e: any) {
      log.error(\`[tgcn] poll: \${e.message}\`);
      if (pollingActive) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

async function handleUpdate(update: any) {
  const msg = update.message;
  if (!msg) return;
  const text = msg.text || msg.caption || "";
  if (!text) return;

  const chatId = msg.chat.id;
  const senderId = String(msg.from?.id || "");
  const senderName = msg.from?.username
    ? \`@\${msg.from.username}\`
    : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const isDirect = !isGroup;

  log.info(\`[tgcn] msg from=\${senderName} chat=\${chatId} text="\${text.substring(0, 50)}"\`);

  await sendTyping(chatId);
  const typingTimer = setInterval(() => sendTyping(chatId), 4000);

  try {
    const peer = { kind: isDirect ? "direct" as const : "group" as const, id: String(chatId) };
    const route = rt.channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: "default", peer });
    log.info(\`[tgcn] route: session=\${route.sessionKey} agent=\${route.agentId}\`);

    const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });

    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey });
    const fromLabel = isDirect ? \`\${senderName} (\${senderId})\` : \`\${chatId} - \${senderName}\`;

    const body = rt.channel.reply.formatInboundEnvelope({
      channel: "Telegram", from: fromLabel,
      timestamp: msg.date ? msg.date * 1000 : Date.now(),
      body: text, chatType: isDirect ? "direct" : "group",
      sender: { name: senderName, id: senderId },
      previousTimestamp, envelope: envelopeOptions,
    });

    const ctx = rt.channel.reply.finalizeInboundContext({
      Body: body, RawBody: text, CommandBody: text,
      From: String(chatId), To: String(chatId),
      SessionKey: route.sessionKey, AccountId: "default",
      ChatType: isDirect ? "direct" : "group",
      ConversationLabel: fromLabel,
      SenderName: senderName, SenderId: senderId,
      Provider: CHANNEL_ID, Surface: CHANNEL_ID,
      MessageSid: String(msg.message_id),
      Timestamp: msg.date ? msg.date * 1000 : Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: CHANNEL_ID, OriginatingTo: String(chatId),
    });

    await rt.channel.session.recordInboundSession({
      storePath, sessionKey: ctx.SessionKey || route.sessionKey, ctx,
      updateLastRoute: isDirect
        ? { sessionKey: route.mainSessionKey, channel: CHANNEL_ID, to: String(chatId), accountId: "default" }
        : undefined,
      onRecordError: (err: unknown) => log.error(\`[tgcn] recordInbound: \${String(err)}\`),
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx, cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }, info?: { kind: string }) => {
          const kind = info?.kind || "block";
          log.info(\`[tgcn] deliver kind=\${kind} len=\${payload.text?.length || 0}\`);
          if (kind === "final" && payload.text?.trim()) {
            await sendTgMessage(chatId, payload.text, msg.message_id);
            log.info("[tgcn] reply sent");
          }
        },
        onError: (err: unknown) => log.error(\`[tgcn] deliver err: \${(err as Error)?.message}\`),
      },
      replyOptions: {},
    });

  } catch (e: any) {
    log.error(\`[tgcn] error: \${e.message}\\n\${e.stack || ""}\`);
    try { await sendTgMessage(chatId, "⚠️ 处理消息出错，请稍后重试。", msg.message_id); } catch {}
  } finally {
    clearInterval(typingTimer);
  }
}

const telegramCnChannel = {
  id: CHANNEL_ID,
  meta: { id: CHANNEL_ID, label: "Telegram CN", selectionLabel: "Telegram CN (native https)", blurb: "Telegram Bot via native https.", aliases: ["tgcn"] },
  capabilities: { chatTypes: ["direct", "group"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default" }) },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async ({ text, envelope }: { text: string; envelope: any }) => {
      const chatId = envelope?.peer ?? envelope?.chatId ?? envelope?.to;
      if (!chatId) return { ok: false };
      try { await sendTgMessage(chatId, text); return { ok: true }; } catch (e: any) { return { ok: false, error: e.message }; }
    },
  },
};

export default function register(api: any) {
  rt = api.runtime;
  cfg = api.config;
  log = api.logger || console;
  log.info("[tgcn] registering...");
  getBotToken();
  log.info(\`[tgcn] botToken: \${BOT_TOKEN ? BOT_TOKEN.substring(0, 10) + "..." : "MISSING"}\`);
  if (!rt?.channel?.routing) log.warn("[tgcn] WARNING: rt.channel.routing missing!");
  if (!rt?.channel?.session?.recordInboundSession) log.warn("[tgcn] WARNING: recordInboundSession missing!");
  if (!rt?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) log.warn("[tgcn] WARNING: dispatchReplyWithBufferedBlockDispatcher missing!");
  api.registerChannel({ plugin: telegramCnChannel });
  api.registerService({
    id: "telegram-cn-poller",
    start: async () => { log.info("[tgcn] poller starting"); startPolling(handleUpdate).catch(e => log.error(\`[tgcn] crash: \${e.message}\`)); },
    stop: async () => { pollingActive = false; log.info("[tgcn] stopped"); },
  });
  log.info("[tgcn] registered");
}
PLUGINEOF
```

---

## 第七步：配置 OpenClaw

```bash
ssh 上海母机 "openclaw config set channels.telegram-cn.enabled true 2>&1"
ssh 上海母机 "openclaw config set channels.telegram-cn.botToken '8752096053:AAHoizRI7cee8cVq0au5PKV-Ffir1p5ggM4' 2>&1"
ssh 上海母机 "openclaw config set channels.telegram-cn.dmPolicy open 2>&1"
ssh 上海母机 "openclaw config set plugins.allow '[\"telegram-cn\"]' 2>&1"
```

贴回输出。

---

## 第八步：重启 Gateway

```bash
ssh 上海母机 "systemctl restart openclaw && sleep 8 && journalctl -u openclaw --no-pager -n 50 2>&1 | grep 'tgcn'"
```

期望看到：
```
[tgcn] registering...
[tgcn] botToken: 8752096053...
[tgcn] registered
[tgcn] poller starting
[tgcn] bot: @Leencntestbot (8752096053)
[tgcn] polling started
```

贴回完整输出。

---

## 第九步：测试

告诉用户："请在 Telegram 里给 @Leencntestbot 发一条消息"。

等用户确认后执行：

```bash
ssh 上海母机 "journalctl -u openclaw --no-pager -n 50 --since '2 min ago' 2>&1 | grep 'tgcn'"
```

期望看到：
```
[tgcn] msg from=@username chat=xxx text="..."
[tgcn] route: session=agent:main:main agent=main
[tgcn] deliver kind=final len=xxx
[tgcn] reply sent
```

贴回完整输出。

---

## 汇报

按步骤编号贴回每一步的完整输出。不要省略，不要自行修复。
