/**
 * TelegramCN - OpenClaw Telegram Channel Plugin
 *
 * 使用 Node.js 原生 https 模块调用 Telegram Bot API，
 * 完全绕开 undici 的网络栈。
 *
 * 功能：
 * - 文本消息收发
 * - 文件上行：用户发文件 → 下载到 ~/.openclaw/media/inbound/ → agent 拿到本地路径
 * - 文件下行：agent 回复本地路径或 [file:路径] → 发给用户
 * - Typing / HTML降级 / 长消息分片
 */

import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ============================================================
// 常量
// ============================================================
const POLL_TIMEOUT = 10;
const RETRY_DELAY = 5000;
const CHANNEL_ID = "telegram-cn";
const MAX_MSG_LEN = 4000;
const INBOUND_DIR = path.join(process.env.HOME || "/root", ".openclaw", "media", "inbound");

// ============================================================
// Runtime
// ============================================================
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
  API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
  if (!BOT_TOKEN && log) log.error("[tgcn] botToken not found in config or env!");
  return BOT_TOKEN;
}

// ============================================================
// Telegram Bot API（原生 https）
// ============================================================
function tgApi(method: string, body?: any): Promise<any> {
  getBotToken();
  if (!BOT_TOKEN) return Promise.reject(new Error("No bot token configured"));
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const url = new URL(`${API_BASE}/${method}`);
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
          if (j.ok) resolve(j.result); else reject(new Error(`TG [${method}]: ${j.description || data}`));
        } catch { reject(new Error(`TG parse: ${data.substring(0, 200)}`)); }
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

// ============================================================
// Markdown → Telegram HTML 转换
// ============================================================

/** 转义 HTML 特殊字符 */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 将 OpenClaw agent 回复的 Markdown 转换为 Telegram 支持的 HTML
 * 支持：代码块、行内代码、粗体、斜体、删除线、链接、标题、引用、列表
 */
function md2tgHtml(md: string): string {
  // 先提取代码块，避免内部被转换
  const codeBlocks: string[] = [];
  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // 提取行内代码
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // 转义 HTML（在代码已经被保护之后）
  text = escHtml(text);

  // 粗斜体（***text*** 或 ___text___）
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // 粗体 **text** 或 __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // 斜体 *text* 或 _text_（不匹配 URL 中的下划线）
  text = text.replace(/(?<![\\w*])\*([^\s*](?:.*?[^\s*])?)\*(?![\\w*])/g, "<i>$1</i>");
  text = text.replace(/(?<![\\w_])_([^\s_](?:.*?[^\s_])?)_(?![\\w_])/g, "<i>$1</i>");

  // 删除线 ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 链接 [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 标题 # → 粗体（Telegram 没有标题标签）
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 引用 > text → Telegram blockquote（如果不支持就用斜体前缀）
  text = text.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  // 合并连续 blockquote
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // 无序列表 - item / * item → • item
  text = text.replace(/^[\s]*[-*]\s+/gm, "• ");

  // 有序列表保持原样（数字.已经可读）

  // 分割线 --- / *** / ___ → ———
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "———");

  // 还原代码块
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  // 还原行内代码
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)]);

  return text.trim();
}

async function sendTgMessage(chatId: number | string, text: string, replyTo?: number) {
  // Markdown → Telegram HTML
  const html = md2tgHtml(text);
  const chunks: string[] = [];
  let rem = html;
  while (rem.length > 0) {
    if (rem.length <= MAX_MSG_LEN) { chunks.push(rem); break; }
    let c = rem.lastIndexOf("\n", MAX_MSG_LEN);
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

// ============================================================
// 文件上行：下载 Telegram 文件到本地 inbound 目录
// ============================================================

/** 获取 Telegram 文件元信息（file_path） */
async function getTgFileMeta(fileId: string): Promise<{ file_path: string; file_size?: number }> {
  return await tgApi("getFile", { file_id: fileId });
}

/** 通过原生 https 下载文件到本地，返回本地绝对路径 */
function downloadTgFile(remotePath: string, localPath: string): Promise<string> {
  getBotToken();
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${remotePath}`;
  return new Promise((resolve, reject) => {
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });

    const url = new URL(fileUrl);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname,
      method: "GET", rejectUnauthorized: false,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300) {
        return reject(new Error(`Download HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(localPath);
      res.pipe(ws);
      ws.on("finish", () => { ws.close(); resolve(localPath); });
      ws.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("download timeout")));
    req.end();
  });
}

/** 从消息中提取媒体信息 */
function extractMediaInfo(msg: any): { type: string; fileId: string; fileName?: string; fileSize?: number; mimeType?: string } | null {
  if (msg.document) return { type: "document", fileId: msg.document.file_id, fileName: msg.document.file_name, fileSize: msg.document.file_size, mimeType: msg.document.mime_type };
  if (msg.photo?.length) { const p = msg.photo[msg.photo.length - 1]; return { type: "photo", fileId: p.file_id, fileSize: p.file_size, mimeType: "image/jpeg" }; }
  if (msg.voice) return { type: "voice", fileId: msg.voice.file_id, fileSize: msg.voice.file_size, mimeType: msg.voice.mime_type || "audio/ogg" };
  if (msg.audio) return { type: "audio", fileId: msg.audio.file_id, fileName: msg.audio.file_name, fileSize: msg.audio.file_size, mimeType: msg.audio.mime_type };
  if (msg.video) return { type: "video", fileId: msg.video.file_id, fileName: msg.video.file_name, fileSize: msg.video.file_size, mimeType: msg.video.mime_type };
  if (msg.sticker) return { type: "sticker", fileId: msg.sticker.file_id, fileSize: msg.sticker.file_size, mimeType: msg.sticker.is_animated ? "application/x-tgsticker" : "image/webp" };
  return null;
}

/** 根据 MIME 类型或文件名推断扩展名 */
function guessExt(media: { type: string; fileName?: string; mimeType?: string }): string {
  if (media.fileName) {
    const e = path.extname(media.fileName);
    if (e) return e;
  }
  const mimeMap: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "video/mp4": ".mp4", "video/quicktime": ".mov",
    "application/pdf": ".pdf", "application/zip": ".zip",
    "application/x-tgsticker": ".tgs",
    "text/plain": ".txt",
  };
  if (media.mimeType && mimeMap[media.mimeType]) return mimeMap[media.mimeType];
  const typeMap: Record<string, string> = { photo: ".jpg", voice: ".ogg", audio: ".mp3", video: ".mp4", sticker: ".webp" };
  return typeMap[media.type] || ".bin";
}

/**
 * 处理 inbound 媒体：下载到 ~/.openclaw/media/inbound/，返回本地路径
 */
async function handleInboundMedia(media: { type: string; fileId: string; fileName?: string; fileSize?: number; mimeType?: string }): Promise<{ localPath: string; remoteUrl: string }> {
  const fileMeta = await getTgFileMeta(media.fileId);
  const remoteUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileMeta.file_path}`;

  // 本地文件名：纯 ASCII，不含原始文件名（避免中文路径问题）
  const uid = crypto.randomBytes(4).toString("hex");
  const ext = guessExt(media);
  const localName = `${uid}_${media.type}${ext}`;
  const localPath = path.join(INBOUND_DIR, localName);

  await downloadTgFile(fileMeta.file_path, localPath);
  return { localPath, remoteUrl };
}

// ============================================================
// 文件下行：multipart 上传到 Telegram
// ============================================================
function sendTgFile(chatId: number | string, filePath: string, replyTo?: number, caption?: string): Promise<any> {
  getBotToken();
  if (!BOT_TOKEN) return Promise.reject(new Error("No bot token configured"));
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    let fileBuffer: Buffer;
    try { fileBuffer = fs.readFileSync(filePath); } catch (e: any) { return reject(new Error(`Cannot read: ${filePath} - ${e.message}`)); }

    const ext = path.extname(fileName).toLowerCase();
    const isImage = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext);
    const method = isImage ? "sendPhoto" : "sendDocument";
    const fieldName = isImage ? "photo" : "document";
    const boundary = "----TgCn" + Date.now().toString(36);
    const parts: Buffer[] = [];

    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
    if (replyTo) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_parameters"\r\n\r\n${JSON.stringify({ message_id: replyTo })}\r\n`));
    if (caption) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = new URL(`${API_BASE}/${method}`);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: "POST", rejectUnauthorized: false,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
    }, (res) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        try { const j = JSON.parse(data); if (j.ok) resolve(j.result); else reject(new Error(`TG [${method}]: ${j.description || data}`)); }
        catch { reject(new Error(`TG parse: ${data.substring(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("upload timeout")));
    req.write(body);
    req.end();
  });
}

/** 检测文本中的文件路径并发送 */
async function trySendFilesFromText(chatId: number | string, text: string, replyTo?: number): Promise<{ sent: boolean; cleanedText: string }> {
  let cleanedText = text;
  let sent = false;
  const sentPaths = new Set<string>();

  // 辅助：resolve 路径并检查文件存在
  function resolvePath(p: string): string | null {
    const trimmed = p.trim();
    if (!trimmed) return null;
    const resolved = trimmed.startsWith("~") ? path.join(process.env.HOME || "/root", trimmed.slice(1)) : trimmed;
    // 安全检查：必须是绝对路径，有扩展名
    if (!path.isAbsolute(resolved)) return null;
    if (!path.extname(resolved)) return null;
    try { if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved; } catch {}
    return null;
  }

  // 辅助：发送文件
  async function trySend(filePath: string, matchStr: string): Promise<boolean> {
    if (sentPaths.has(filePath)) return true;
    try {
      await sendTgFile(chatId, filePath, replyTo);
      log.info(`[tgcn] file sent: ${filePath}`);
      sentPaths.add(filePath);
      cleanedText = cleanedText.replace(matchStr, "").trim();
      return true;
    } catch (e: any) {
      log.error(`[tgcn] file send failed: ${filePath} - ${e.message}`);
      return false;
    }
  }

  // 1. [file:路径] 标签格式
  const fileTagRegex = /\[file:([^\]]+)\]/g;
  let match;
  while ((match = fileTagRegex.exec(text)) !== null) {
    const resolved = resolvePath(match[1]);
    if (resolved) { if (await trySend(resolved, match[0])) sent = true; }
  }

  // 2. 行内绝对路径提取（覆盖 "路径: /xxx"、"• /xxx"、"文件: /xxx" 等各种格式）
  //    匹配任何位置出现的 /绝对路径.扩展名 或 ~/路径.扩展名
  const inlinePathRegex = /((?:\/|~\/)[^\s<>"'`,;!?\[\](){}]+\.\w{1,10})/g;
  const lines = cleanedText.split("\n");
  const remainingLines: string[] = [];

  for (const line of lines) {
    const paths: string[] = [];
    let lineMatch;
    // 重置 lastIndex
    inlinePathRegex.lastIndex = 0;
    while ((lineMatch = inlinePathRegex.exec(line)) !== null) {
      const resolved = resolvePath(lineMatch[1]);
      if (resolved && !sentPaths.has(resolved)) paths.push(resolved);
    }

    if (paths.length > 0) {
      let modifiedLine = line;
      for (const p of paths) {
        if (await trySend(p, "")) sent = true;
      }
      // 清理掉包含路径的行中的路径部分，如果行只剩标点/标签则整行移除
      for (const p of paths) {
        // 从行中移除路径及前面的 "路径:" "文件:" 等标签
        modifiedLine = modifiedLine.replace(new RegExp(`[•\\-*]?\\s*(?:路径|文件|file|path)\\s*[:：]\\s*${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, "gi"), "").trim();
        // 如果上面没匹配到（路径没有前缀标签），直接移除路径本身
        modifiedLine = modifiedLine.replace(p, "").trim();
      }
      // 如果整行清理后只剩空白或标点符号，跳过整行
      if (!modifiedLine || /^[•\-*\s:：。，]+$/.test(modifiedLine)) continue;
      remainingLines.push(modifiedLine);
    } else {
      remainingLines.push(line);
    }
  }

  cleanedText = remainingLines.join("\n").trim();

  // 清理可能残留的空行
  cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n");

  return { sent, cleanedText };
}

// ============================================================
// Long Polling
// ============================================================
let pollingActive = false;
let lastOffset = 0;

async function startPolling(onMsg: (u: any) => Promise<void>) {
  pollingActive = true;
  try { await tgApi("deleteWebhook", { drop_pending_updates: false }); } catch {}
  try { const me = await tgApi("getMe"); log.info(`[tgcn] bot: @${me.username} (${me.id})`); }
  catch (e: any) { log.error(`[tgcn] getMe failed: ${e.message}`); return; }

  // 确保 inbound 目录存在
  fs.mkdirSync(INBOUND_DIR, { recursive: true });

  log.info(`[tgcn] polling started (inbound: ${INBOUND_DIR})`);
  while (pollingActive) {
    try {
      const updates = await tgApi("getUpdates", { offset: lastOffset, timeout: POLL_TIMEOUT, allowed_updates: ["message"] });
      if (Array.isArray(updates)) for (const u of updates) {
        lastOffset = u.update_id + 1;
        try { await onMsg(u); } catch (e: any) { log.error(`[tgcn] handler: ${e.message}`); }
      }
    } catch (e: any) {
      log.error(`[tgcn] poll: ${e.message}`);
      if (pollingActive) await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

// ============================================================
// 核心：消息处理
// ============================================================
async function handleUpdate(update: any) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const senderId = String(msg.from?.id || "");
  const senderName = msg.from?.username ? `@${msg.from.username}` : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const isDirect = !isGroup;

  // 构造 inbound 文本
  let inboundText = msg.text || msg.caption || "";
  let localMediaPath: string | undefined;
  let mediaFileUrl: string | undefined;
  const media = extractMediaInfo(msg);

  if (media) {
    try {
      const { localPath, remoteUrl } = await handleInboundMedia(media);
      localMediaPath = localPath;
      mediaFileUrl = remoteUrl;

      const typeLabel = { photo: "图片", voice: "语音", video: "视频", audio: "音频", sticker: "贴纸", document: "文件" }[media.type] || "文件";
      const mediaDesc = [
        `\n[用户发送了${typeLabel}]`,
        media.fileName ? `文件名: ${media.fileName}` : null,
        media.mimeType ? `类型: ${media.mimeType}` : null,
        media.fileSize ? `大小: ${(media.fileSize / 1024).toFixed(1)}KB` : null,
        `本地路径: ${localPath}`,
      ].filter(Boolean).join("\n");
      inboundText = inboundText ? `${inboundText}\n${mediaDesc}` : mediaDesc;
      log.info(`[tgcn] media downloaded: type=${media.type} → ${localPath}`);
    } catch (e: any) {
      log.error(`[tgcn] media download failed: ${e.message}`);
      inboundText = inboundText ? `${inboundText}\n[用户发送了文件，但下载失败: ${e.message}]` : `[用户发送了文件，但下载失败: ${e.message}]`;
    }
  }

  if (!inboundText.trim()) return;

  log.info(`[tgcn] msg from=${senderName} chat=${chatId} text="${inboundText.substring(0, 80)}"`);
  await sendTyping(chatId);
  const typingTimer = setInterval(() => sendTyping(chatId), 4000);

  try {
    const peer = { kind: isDirect ? "direct" as const : "group" as const, id: String(chatId) };
    const route = rt.channel.routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: "default", peer });

    const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey });
    const fromLabel = isDirect ? `${senderName} (${senderId})` : `${chatId} - ${senderName}`;

    const body = rt.channel.reply.formatInboundEnvelope({
      channel: "Telegram", from: fromLabel,
      timestamp: msg.date ? msg.date * 1000 : Date.now(),
      body: inboundText, chatType: isDirect ? "direct" : "group",
      sender: { name: senderName, id: senderId },
      previousTimestamp, envelope: envelopeOptions,
    });

    const ctx = rt.channel.reply.finalizeInboundContext({
      Body: body, RawBody: inboundText, CommandBody: inboundText,
      From: String(chatId), To: String(chatId),
      SessionKey: route.sessionKey, AccountId: "default",
      ChatType: isDirect ? "direct" : "group", ConversationLabel: fromLabel,
      SenderName: senderName, SenderId: senderId,
      Provider: CHANNEL_ID, Surface: CHANNEL_ID,
      MessageSid: String(msg.message_id),
      Timestamp: msg.date ? msg.date * 1000 : Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: CHANNEL_ID, OriginatingTo: String(chatId),
      MediaPath: localMediaPath, MediaType: media?.mimeType, MediaUrl: mediaFileUrl,
    });

    await rt.channel.session.recordInboundSession({
      storePath, sessionKey: ctx.SessionKey || route.sessionKey, ctx,
      updateLastRoute: isDirect ? { sessionKey: route.mainSessionKey, channel: CHANNEL_ID, to: String(chatId), accountId: "default" } : undefined,
      onRecordError: (err: unknown) => log.error(`[tgcn] recordInbound: ${String(err)}`),
    });

    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx, cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info?: { kind: string }) => {
          const kind = info?.kind || "block";
          if (kind !== "final") return;

          // agent 回复中的 mediaUrl/mediaUrls → 发文件
          const urls = [...(payload.mediaUrl ? [payload.mediaUrl] : []), ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [])].filter(u => typeof u === "string" && u.trim());
          for (const u of urls) {
            const resolved = u.startsWith("~") ? path.join(process.env.HOME || "/root", u.slice(1)) : u;
            if (fs.existsSync(resolved)) {
              try { await sendTgFile(chatId, resolved, msg.message_id); log.info(`[tgcn] media sent: ${resolved}`); }
              catch (e: any) { log.error(`[tgcn] media send failed: ${resolved} - ${e.message}`); }
            }
          }

          // 文本回复（含嵌入文件路径检测）
          if (payload.text?.trim()) {
            const { sent, cleanedText } = await trySendFilesFromText(chatId, payload.text, msg.message_id);
            if (cleanedText.trim()) { await sendTgMessage(chatId, cleanedText, msg.message_id); log.info("[tgcn] reply sent"); }
            else if (sent) { log.info("[tgcn] file(s) sent, no text"); }
          }
        },
        onError: (err: unknown) => log.error(`[tgcn] deliver err: ${(err as Error)?.message}`),
      },
      replyOptions: {},
    });

  } catch (e: any) {
    log.error(`[tgcn] error: ${e.message}\n${e.stack || ""}`);
    try { await sendTgMessage(chatId, "⚠️ 处理消息出错，请稍后重试。", msg.message_id); } catch {}
  } finally { clearInterval(typingTimer); }
}

// ============================================================
// Channel Plugin
// ============================================================
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
      try {
        const { cleanedText } = await trySendFilesFromText(chatId, text);
        if (cleanedText.trim()) await sendTgMessage(chatId, cleanedText);
        return { ok: true };
      } catch (e: any) { return { ok: false, error: e.message }; }
    },
    sendMedia: async ({ to, mediaPath }: any) => {
      if (!to || !mediaPath) return { ok: false };
      const resolved = mediaPath.startsWith("~") ? path.join(process.env.HOME || "/root", mediaPath.slice(1)) : mediaPath;
      try { await sendTgFile(to, resolved); return { ok: true }; }
      catch (e: any) { return { ok: false, error: e.message }; }
    },
  },
};

// ============================================================
// 注册
// ============================================================
export default function register(api: any) {
  rt = api.runtime;
  cfg = api.config;
  log = api.logger || console;

  api.registerChannel({ plugin: telegramCnChannel });

  api.registerService({
    id: "telegram-cn-poller",
    start: async () => {
      getBotToken();
      if (!BOT_TOKEN) { log.error("[tgcn] botToken not configured! Set channels.telegram-cn.botToken in config."); return; }
      log.info(`[tgcn] starting (token: ${BOT_TOKEN.substring(0, 10)}...)`);
      if (!rt?.channel?.routing) { log.error("[tgcn] rt.channel.routing missing!"); return; }
      if (!rt?.channel?.session?.recordInboundSession) { log.error("[tgcn] recordInboundSession missing!"); return; }
      if (!rt?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) { log.error("[tgcn] dispatchReply missing!"); return; }
      startPolling(handleUpdate).catch(e => log.error(`[tgcn] crash: ${e.message}`));
    },
    stop: async () => { pollingActive = false; log.info("[tgcn] stopped"); },
  });
}
