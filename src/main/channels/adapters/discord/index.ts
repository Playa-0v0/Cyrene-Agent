// DiscordAdapter —— implements ChannelAdapter。
//
// 接入方式：**长连接 WebSocket**（discord.js Gateway）。
// 和飞书一样是完全出站连接：
//   - 不需要公网 HTTPS URL / 内网穿透
//   - 重连 / 心跳 / 鉴权由 discord.js Client 自动处理
//   - 需要提供一个 Discord Bot Token（在 Discord Developer Portal 创建 Bot 后获取）
//
// 数据流：
//   Discord Gateway ←WSS→ discord.js Client
//       ↓ `messageCreate` (DM message)
//   DiscordAdapter.handleMessage → adapter.onMessage (dispatcher)
//       ↓ CyreneAgent runs
//   DiscordAdapter.send(...) → channel.send(...) → Discord 用户私信
//
// 设计决策：
//   - 只处理**私聊(用户 DM)**。群聊 / 串音频道（@mention）暂不处理，跟飞书 p2p-only 一致。
//   - 入站图片/文件会先下载到 userData/channels/cache/，再以本地 filePath 写入
//     IncomingMessage.attachments，buildAgentRunOptions 会把路径注入 prompt。
//   - 出站 parts 翻译：text → 纯文本；image/file/audio/video → AttachmentBuilder；
//     card → EmbedBuilder；sticker → 当作图片附件。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  ChannelAttachment,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings } from "../../settings-store";
import { logger, LogTag } from "../../../logger";

const LOG = "[DiscordAdapter]";

/** Discord capability 声明。Discord 原生支持文本/富文本(markdown)/embed/附件。 */
const DISCORD_CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: false, // Discord 没有我们的"内置表情包"；sticker 会按 cap 降级跳过
  maxTextLength: 2000, // Discord 单条消息上限 2000 字符
};

/** 根据 URL 后缀 / MIME 推断下载后的扩展名。 */
function extFromUrl(url: string, fallback = ".bin"): string {
  try {
    const clean = url.split("?")[0];
    const m = /\.([a-zA-Z0-9]+)$/.exec(clean);
    return m ? `.${m[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ogg":
    case ".oga": return "audio/ogg";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".txt":
    case ".md":
    case ".log":
    case ".csv": return "text/plain";
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

/** 把 Discord 附件下载到本地缓存目录，返回本地路径。失败返回 null。 */
async function downloadDiscordAttachment(
  url: string,
  fileName: string | undefined,
  fallbackKind: ChannelAttachment["kind"],
): Promise<{ filePath: string; mime: string } | null> {
  try {
    const cacheDir = path.join(app.getPath("userData"), "channels", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const ext = fileName ? path.extname(fileName).toLowerCase() || extFromUrl(url) : extFromUrl(url);
    // 命名: discord-<timestamp>-<名字 或 kind>.<ext>
    const baseName = fileName
      ? fileName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)
      : fallbackKind;
    const localPath = path.join(cacheDir, `discord-${Date.now()}-${baseName}${ext}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(localPath, buf);
    return { filePath: localPath, mime: mimeFromExt(ext) };
  } catch (err) {
    console.warn(LOG, `下载 Discord 附件失败:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 把出站 parts 翻译成 Discord 可发送的内容（单条消息可能含多附件/多 embed）。 */
function buildDiscordSendPayload(parts: OutgoingPart[]): {
  text: string;
  attachments: AttachmentBuilder[];
  embeds: EmbedBuilder[];
} {
  const textParts: string[] = [];
  const attachments: AttachmentBuilder[] = [];
  const embeds: EmbedBuilder[] = [];

  for (const part of parts) {
    switch (part.kind) {
      case "text": {
        const t = (part.text ?? "").trim();
        if (t) textParts.push(t);
        break;
      }
      case "card": {
        const embed = new EmbedBuilder().setTitle(part.title);
        if (part.markdown) {
          // Discord embed description 支持 markdown 语法
          const desc = part.markdown.slice(0, 4000);
          embed.setDescription(desc);
        }
        if (part.fields && part.fields.length > 0) {
          embed.addFields(
            part.fields.map((f) => ({ name: f.key.slice(0, 256), value: f.value.slice(0, 1024) })),
          );
        }
        embeds.push(embed);
        break;
      }
      case "image": {
        const src = part.filePath ?? part.url;
        if (src) {
          attachments.push(
            new AttachmentBuilder(src, { name: path.basename(src).slice(0, 100) }),
          );
        }
        break;
      }
      case "sticker": {
        // Discord 无法发内置表情；改为图片附件
        if (part.imagePath) {
          attachments.push(
            new AttachmentBuilder(part.imagePath, { name: `${part.stickerId}.png` }),
          );
        }
        break;
      }
      case "audio":
      case "video":
      case "file": {
        if (part.filePath) {
          const name = part.kind === "file"
            ? (part.name ?? path.basename(part.filePath))
            : path.basename(part.filePath);
          attachments.push(
            new AttachmentBuilder(part.filePath, { name: name.slice(0, 100) }),
          );
        }
        break;
      }
    }
  }

  return { text: textParts.join("\n").slice(0, 2000), attachments, embeds };
}

/** 把 Discord Message 归一化成 IncomingMessage（异步，会下载附件）。 */
async function normalizeDiscordMessage(msg: Message): Promise<IncomingMessage> {
  const attachments: IncomingMessage["attachments"] = [];
  let text = msg.content ?? "";

  // 下载附件到本地，供 LLM 使用
  for (const att of msg.attachments.values()) {
    // stiker / emoji 之外都可当作 file/image/audio/video
    const kind: ChannelAttachment["kind"] = att.contentType?.startsWith("image/")
      ? "image"
      : att.contentType?.startsWith("audio/")
        ? "audio"
        : att.contentType?.startsWith("video/")
          ? "video"
          : "file";
    const downloaded = await downloadDiscordAttachment(att.url, att.name, kind);
    if (downloaded) {
      attachments.push({
        kind,
        filePath: downloaded.filePath,
        mime: downloaded.mime,
        caption: att.name,
      });
    }
  }
  // 把附件路径嵌进 text，让 LLM 一眼看到
  for (const a of attachments) {
    if (a.filePath) text = (text ? text + "\n" : "") + `[附件: ${a.filePath}]`;
  }

  return {
    channel: "discord",
    senderId: msg.author.id,
    senderName: msg.author.username,
    chatId: msg.author.id, // DM：chatId = 用户 id
    text: text || "[空消息]",
    attachments: attachments.length > 0 ? attachments : undefined,
    at: msg.createdAt,
    _raw: { id: msg.id, content: msg.content },
  };
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  readonly displayName = "Discord";
  readonly capability = DISCORD_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private client: Client | null = null;
  private status: ChannelStatus = { enabled: false, phase: "config_missing" };
  private started = false;

  constructor() {}

  /** 生成一个新的 discord.js Client（token 变化后 rebuild 用）。 */
  private createClient(): Client {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel, Partials.Message],
    });

    client.once(Events.ClientReady, (c) => {
      console.log(LOG, `ready: 已登录 ${c.user?.username}`);
      this.status = { enabled: true, phase: "running", message: `已连接（${c.user?.tag ?? c.user?.username}）` };
    });

    client.on(Events.Error, (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "client error:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    });

    client.on(Events.MessageCreate, (msg) => {
      void this.handleMessage(msg);
    });

    return client;
  }

  private async handleMessage(msg: Message): Promise<void> {
    // 忽略自己发的消息
    if (msg.author?.id === this.client?.user?.id) return;
    // 只处理私聊（用户 DM）。跳过群聊。
    if (msg.channel?.type !== ChannelType.DM) {
      // console.log(LOG, `忽略 ${msg.channel?.type} 消息 (私聊优先)`);
      return;
    }
    // 忽略 bot 账号（避免 Bot 之间死循环）
    if (msg.author?.bot) return;

    if (!this.onMessage) {
      console.warn(LOG, "onMessage 未注入，跳过消息");
      return;
    }

    // 去重：Discord 偶尔会重复投递同一事件
    if (msg.id && this.#seenMessageIds.has(msg.id)) return;
    if (msg.id) this.#seenMessageIds.add(msg.id);
    // 简单上限，防止 set 无限膨胀
    if (this.#seenMessageIds.size > 1000) {
      this.#seenMessageIds.clear();
    }

    try {
      const incoming = await normalizeDiscordMessage(msg);
      await this.onMessage(incoming);
    } catch (err) {
      console.error(LOG, "处理入站消息失败:", err instanceof Error ? err.message : err);
    }
  }

  #seenMessageIds = new Set<string>();

  async start(): Promise<void> {
    if (this.started) return;

    const settings = loadChannelsSettings().discord;
    if (!settings.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未启用" };
      return;
    }
    const token = (settings.token ?? "").trim();
    if (!token) {
      this.status = { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
      return;
    }

    try {
      this.status = { enabled: true, phase: "starting", message: "连接 Discord Gateway…" };
      this.client = this.createClient();
      this.started = true;
      await this.client.login(token);
      logger.info(LogTag.Channels, `discord adapter started`);
    } catch (err) {
      this.started = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "login() failed:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.client) {
      try {
        this.client.destroy();
      } catch (err) {
        console.warn(LOG, "destroy 失败:", err);
      }
      this.client = null;
    }
    this.#seenMessageIds.clear();
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.client?.user) {
      console.warn(LOG, "send 失败: Discord 未连接");
      return { ok: false, error: "Discord 未连接" };
    }
    if (!msg.parts || msg.parts.length === 0) {
      return { ok: false, error: "没有可发送的内容" };
    }

    // DM 场景：targetId = 用户 id。通过 client.users.fetch 或直接发 DM。
    const { text, attachments, embeds } = buildDiscordSendPayload(msg.parts);
    if (!text && attachments.length === 0 && embeds.length === 0) {
      return { ok: false, error: "没有可发送的内容（capability 全部被降级）" };
    }

    try {
      const user = await this.client.users.fetch(msg.targetId);
      await user.send({ content: text || undefined, files: attachments, embeds });
      console.log(LOG, `send ok: target=${msg.targetId} parts=${msg.parts.length}`);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(LOG, `send 失败 [${msg.targetId}]:`, reason);
      return { ok: false, error: reason };
    }
  }

  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().discord;
    if (!settings.enabled) {
      return { enabled: false, phase: "offline", message: "未启用" };
    }
    if (!settings.token) {
      return { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
    }
    return this.status;
  }

  /** 给外部：触发重建（用户改了 token 后调用）。 */
  public async rebuild(): Promise<void> {
    await this.stop();
    await this.start();
  }
}
