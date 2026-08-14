// DiscordAdapter —— implements ChannelAdapter。
//
// 接入方式：**长连接 WebSocket**（discord.js Gateway）。
// 和飞书一样是完全出站连接：
//   - 不需要公网 HTTPS URL / 内网穿透
//   - 重连 / 心跳 / 鉴权由 discord.js Client 自动处理
//   - 需要提供一个 Discord Bot Token（在 Discord Developer Portal 创建 Bot 后获取）
//
// 數據流：
//   Discord Gateway ←WSS→ discord.js Client
//       ↓ `messageCreate` / `interactionCreate`
//   DiscordAdapter.handleMessage / handleInteraction → adapter.onMessage (dispatcher)
//       ↓ CyreneAgent runs
//   DiscordAdapter.send(...) → 回覆至同一頻道或私訊
//
// 對話模式（在**伺服器頻道**中對話，用正式 slash command）：
//   - 連上時自動在 Bot 已加入的每個伺服器註冊 `/startagent`（guild command，立即生效）。
//   - 使用者在你想要對話的文字頻道輸入 `/startagent` → 該頻道被綁定為唯一「對話頻道」，
//     綁定會透過 settings-store 持久化，重啟後仍保留，同步收到「啟動成功」回覆。
//   - 之後只有**綁定頻道**裡有人 **@ 提到 Bot** 才會觸發對話，回覆在同一個頻道。
//   - 你可以隨時回到該頻道確認完整對話內容（不另建頻道）。
//   - 私訊(DM) 仍然可用：直接私訊 Bot 即可對話。
//
// 設計決策：
//   - 群聊頻道：僅當被 `/startagent` 綁定頻道 + 有人 @Bot 時回應；避免誤觸發 / 刷屏。
//   - 入站圖片/文件會下載到 userData/channels/cache/，以 filePath 寫進
//     IncomingMessage.attachments，buildAgentRunOptions 會把路徑注入 prompt。
//   - 出站 parts 翻譯：text → 純文本；image/file/audio/video → AttachmentBuilder；
//     card → EmbedBuilder；sticker → 當作圖片附件。
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
  type BaseGuildTextChannel,
  type ChatInputCommandInteraction,
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
import { loadChannelsSettings, saveChannelsSettings } from "../../settings-store";
import {
  ensureDiscordSessionAndOpen,
  appendDiscordUserMessage,
  appendDiscordReply,
  getLastChannelError,
} from "./discord-session";
import { loadModelSettings } from "../../../settings/model-settings";
import { logger, LogTag } from "../../../logger";

const LOG = "[DiscordAdapter]";

/** 頻道綁定的正式 slash command 名稱。 */
const SLASH_STARTAGENT = "startagent";
const SLASH_STARTAGENT_DESC = "把本頻道設為 Cyrene 的對話頻道（之後在本頻道 @我 就能對話）";
const SLASH_STATUS = "status";
const SLASH_STATUS_DESC = "顯示目前使用的模型/API 設定與最近一次的錯誤訊息";

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
          embed.setDescription(part.markdown.slice(0, 4000));
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

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  readonly displayName = "Discord";
  readonly capability = DISCORD_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private client: Client | null = null;
  private status: ChannelStatus = { enabled: false, phase: "config_missing" };
  private started = false;
  #seenMessageIds = new Set<string>();

  constructor() {}

  /** 生成一个新的 discord.js Client（token 变化后 rebuild 用）。 */
  private createClient(): Client {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.once(Events.ClientReady, (c) => {
      console.log(LOG, `ready: 已登录 ${c.user?.username}`);
      this.status = { enabled: true, phase: "running", message: `已连接（${c.user?.tag ?? c.user?.username}）` };
      void this.registerSlashCommands(c);
      const cfg = loadChannelsSettings().discord;
      if (cfg.boundChannelId) {
        console.log(LOG, `已綁定對話頻道: ${cfg.boundChannelName ?? cfg.boundChannelId}`);
      }
    });

    client.on(Events.Error, (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "client error:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    });

    client.on(Events.MessageCreate, (msg) => {
      void this.handleMessage(msg);
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });

    return client;
  }

  /** 連上後，在每個已加入的伺服器註冊 /startagent /status（guild command，立即生效；重複註冊用 set 覆蓋）。 */
  private async registerSlashCommands(client: Client): Promise<void> {
    const commandData = [
      { name: SLASH_STARTAGENT, description: SLASH_STARTAGENT_DESC },
      { name: SLASH_STATUS, description: SLASH_STATUS_DESC },
    ];
    try {
      const app = client.application;
      if (!app?.id) {
        console.warn(LOG, "application 資訊尚不可用，跳過註冊指令");
        return;
      }
      for (const guild of client.guilds.cache.values()) {
        try {
          await guild.commands.set(commandData);
          console.log(LOG, `已註冊 /${SLASH_STARTAGENT} /${SLASH_STATUS} 到 ${guild.name} (${guild.id})`);
        } catch (err) {
          console.warn(LOG, `註冊指令到 ${guild.id} 失敗:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.warn(LOG, "註冊指令失敗（請在 Bot 的 OAuth2 scope 勾選 applications.commands）:", err instanceof Error ? err.message : err);
    }
  }

  /** 處理 slash command 互動：/startagent → 綁定頻道；/status → 回報模型與錯誤。 */
  private async handleInteraction(interaction: unknown): Promise<void> {
    if (!(interaction as { isChatInputCommand?: () => boolean }).isChatInputCommand?.()) return;
    const cmd = interaction as ChatInputCommandInteraction;

    // /status：回報模型/API 設定與最近一次錯誤（可在任意頻道或私訊使用）
    if (cmd.commandName === SLASH_STATUS) {
      await this.handleStatusCommand(cmd);
      return;
    }
    if (cmd.commandName !== SLASH_STARTAGENT) return;

    // 先 defer，避免後續 fetch / 綁定超過 3 秒的互動時限
    try {
      await cmd.deferReply({ ephemeral: false });
    } catch (err) {
      console.warn(LOG, `/${SLASH_STARTAGENT} deferReply 失敗:`, err instanceof Error ? err.message : err);
      return;
    }

    // 只在伺服器文字頻道中使用
    if (!cmd.inGuild() || !cmd.channelId) {
      await cmd.editReply("請在伺服器的文字頻道中使用 /startagent。").catch(() => {});
      return;
    }

    try {
      // fetch 真實頻道，避免對 partial channel 呼叫 isTextBased() 而 crash
      const fetched = await cmd.channel?.fetch();
      if (!fetched || fetched.type !== ChannelType.GuildText) {
        await cmd.editReply("請在一般文字頻道中使用 /startagent。").catch(() => {});
        return;
      }
      const channel = fetched as BaseGuildTextChannel;
      const channelName = channel.name ?? cmd.channelId;
      const cfg = loadChannelsSettings().discord;
      const changed = cfg.boundChannelId !== cmd.channelId;

      saveChannelsSettings({
        discord: {
          ...cfg,
          boundChannelId: cmd.channelId,
          boundChannelName: channelName,
        },
      });

      console.log(LOG, `/${SLASH_STARTAGENT}: 綁定頻道 ${channelName} (${cmd.channelId})`);
      // 建立或取得桌面端 Discord 對話（chat 模式），並嘗試開啟聊天窗
      ensureDiscordSessionAndOpen(`Discord 對話 - #${channelName}`);
      await cmd.editReply(
        changed
          ? `✅ 啟動成功！已把本頻道 #${channelName} 設為 Cyrene 的對話頻道。之後在頻道裡 **@我** 就能跟我對話，我也會在這裡回覆。`
          : `✅ 啟動成功！本頻道 (#${channelName}) 已是指定的對話頻道，直接在頻道裡 **@我** 就能開始對話。`,
      ).catch(() => {});
    } catch (err) {
      console.warn(LOG, `/${SLASH_STARTAGENT} 綁定失敗:`, err instanceof Error ? err.message : err);
      await cmd.editReply("❌ 啟動失敗，請確認我有權限在此頻道發言。").catch(() => {});
    }
  }

  /** 處理 /status：回報目前模型/API 設定與最近一次錯誤（供除錯，無需綁定頻道）。 */
  private async handleStatusCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    try {
      await cmd.deferReply({ ephemeral: false });
    } catch (err) {
      console.warn(LOG, `/status deferReply 失敗:`, err instanceof Error ? err.message : err);
      return;
    }

    const lines: string[] = [];
    const dsc = loadChannelsSettings().discord;
    lines.push("**📊 Cyrene Agent 狀態**");
    lines.push(`- 綁定頻道：${dsc.boundChannelName ? `#${dsc.boundChannelName}` : "尚未綁定（請用 /startagent）"}`);

    // 模型/API 設定
    try {
      const ms = loadModelSettings();
      lines.push("");
      lines.push("**🤖 模型 / API**");
      lines.push(`- provider：${ms.provider || "(空)"}`);
      lines.push(`- model：${ms.model || "(空)"}`);
      lines.push(`- baseUrl：${ms.baseUrl || "(空)"}`);
      lines.push(`- API Key：${ms.apiKey ? `已填（${maskKey(ms.apiKey)}）` : "❌ 未填"}`);
      lines.push(`- transport：${ms.explicitTransport ?? "auto"}`);
      if (ms.modelProfiles?.length) {
        lines.push(`- 已存模型設定檔：${ms.modelProfiles.map((p) => p.model ?? p.provider).join("、")}`);
      }
    } catch (err) {
      lines.push("", "- 讀取模型設定失敗：" + (err instanceof Error ? err.message : String(err)));
    }

    // 最近一次錯誤
    const last = getLastChannelError();
    lines.push("");
    lines.push("**⚠️ 最近一次錯誤**");
    if (!last) {
      lines.push("- 尚無錯誤紀錄。");
    } else {
      const t = new Date(last.at);
      lines.push(`- 時間：${t.toLocaleString()}`);
      if (last.channel) lines.push(`- 來源 session：\`${last.channel}\``);
      if (last.errorName) lines.push(`- 錯誤型別：${last.errorName}`);
      if (last.errorCode) lines.push(`- 錯誤代碼：${last.errorCode}`);
      lines.push(`- 訊息：${last.errorMessage || "(無)"}`);
    }

    // 操作提示
    lines.push("");
    lines.push("> 若 API Key 未填或錯誤，請到 Cyrene 設定 → 模型，確認 provider/Key/模型名。");

    const text = lines.join("\n").slice(0, 2000);
    await cmd.editReply(text).catch(() => {});
  }

  /** 入口：處理所有普通訊息，決定是否觸發對話。 */
  private async handleMessage(msg: Message): Promise<void> {
    // 忽略自己發的消息與其他 bot
    if (msg.author?.id === this.client?.user?.id) return;
    if (msg.author?.bot) return;
    if (!this.onMessage) {
      console.warn(LOG, "onMessage 未注入，跳過消息");
      return;
    }

    const isGuildChannel = msg.guildId != null;
    const isDM = msg.channel?.type === ChannelType.DM;

    // 1) 伺服器頻道：只有「/startagent 綁定頻道 + @ 提到 Bot」才觸發
    if (isGuildChannel) {
      if (!await this.isBoundChannel(msg.channelId)) {
        return;
      }
      const mentionedBot = Boolean(this.client?.user) && msg.mentions.has(this.client!.user!.id);
      if (!mentionedBot) {
        return; // 沒 @Bot 就不回應，避免刷屏
      }
      const clean = stripBotMention((msg.content ?? "").trim(), this.client!.user!.id);
      await this.dispatchIncoming(msg, clean, true);
      return;
    }

    // 2) 私訊：直接觸發
    if (isDM) {
      await this.dispatchIncoming(msg, (msg.content ?? "").trim(), false);
      return;
    }

    // 其他類型（話題/公告等）忽略
  }

  /** 綁定頻道存在與否（由 /startagent 寫入 settings-store）。 */
  private async isBoundChannel(channelId?: string): Promise<boolean> {
    if (!channelId) return false;
    const cfg = loadChannelsSettings().discord;
    return cfg.boundChannelId === channelId;
  }

  /** 去重 + 下載附件 + 轉成 IncomingMessage 並交給 dispatcher。
   *  fromGuild=true 時，把「給 agent 處理的那則用戶訊息」與「Bot 回覆」鏡像到桌面端 Discord 對話。 */
  private async dispatchIncoming(msg: Message, text: string, fromGuild: boolean): Promise<void> {
    // 去重
    if (msg.id && this.#seenMessageIds.has(msg.id)) return;
    if (msg.id) this.#seenMessageIds.add(msg.id);
    if (this.#seenMessageIds.size > 1000) this.#seenMessageIds.clear();

    const sessionTitle = this.discordSessionTitle();
    if (fromGuild && text.trim()) {
      appendDiscordUserMessage(sessionTitle, text);
    }

    try {
      const incoming = await this.normalizeDiscordMessage(msg, text);
      const outgoing = await this.onMessage!(incoming);
      // 鏡像 Bot 回覆到桌面端 Discord 對話
      if (fromGuild && outgoing?.parts) {
        const replyText = outgoing.parts
          .filter((p) => p.kind === "text")
          .map((p) => (p as { text: string }).text)
          .join("\n")
          .trim();
        if (replyText) appendDiscordReply(sessionTitle, replyText);
      }
    } catch (err) {
      console.error(LOG, "處理入站消息失敗:", err instanceof Error ? err.message : err);
      try {
        await this.sendDirectAck(msg);
      } catch { /* ignore */ }
    }
  }

  /** 桌面端 Discord 對話的顯示標題。 */
  private discordSessionTitle(): string {
    const cfg = loadChannelsSettings().discord;
    return cfg.boundChannelName ? `Discord 對話 - #${cfg.boundChannelName}` : "Discord 對話";
  }

  /** 把 Discord Message 歸一化成 IncomingMessage（含附件下載）。 */
  private async normalizeDiscordMessage(msg: Message, text: string): Promise<IncomingMessage> {
    const attachments: IncomingMessage["attachments"] = [];
    const fromGuild = msg.guildId != null;

    for (const att of msg.attachments.values()) {
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
    for (const a of attachments) {
      if (a.filePath) text = (text ? text + "\n" : "") + `[附件: ${a.filePath}]`;
    }

    return {
      channel: "discord",
      senderId: msg.author.id,
      senderName: msg.author.username,
      // 頻道模式：chatId = 頻道 id，replies 回到同一頻道；DM：chatId = 使用者 id
      chatId: fromGuild ? msg.channelId : msg.author.id,
      text: (text || "").trim() || "[空消息]",
      attachments: attachments.length > 0 ? attachments : undefined,
      at: msg.createdAt,
      _raw: { id: msg.id, content: msg.content, channelId: msg.channelId, guildId: msg.guildId },
    };
  }

  /** 觸發訊息處理失敗時的簡短澄清回覆。 */
  private async sendDirectAck(msg: Message): Promise<void> {
    const text = "我處理你的訊息時出了點問題，請稍後重試。";
    const target = msg.guildId ? (msg.channel as BaseGuildTextChannel) : null;
    if (target) {
      await target.send(text);
    } else if (msg.channel && msg.channel.isDMBased()) {
      await msg.author.send(text);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;

    const settings = loadChannelsSettings().discord;
    if (!settings.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未啟用" };
      return;
    }
    const token = (settings.token ?? "").trim();
    if (!token) {
      this.status = { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
      return;
    }

    try {
      this.status = { enabled: true, phase: "starting", message: "連接 Discord Gateway…" };
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
        console.warn(LOG, "destroy 失敗:", err);
      }
      this.client = null;
    }
    this.#seenMessageIds.clear();
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) {
      console.warn(LOG, "send 失敗: Discord 未連接");
      return { ok: false, error: "Discord 未連接" };
    }
    if (!msg.parts || msg.parts.length === 0) {
      return { ok: false, error: "沒有可發送的內容" };
    }

    const { text, attachments, embeds } = buildDiscordSendPayload(msg.parts);
    if (!text && attachments.length === 0 && embeds.length === 0) {
      return { ok: false, error: "沒有可發送的內容（capability 全部被降級）" };
    }

    // targetId 可能是頻道 id（頻道模式）或使用者 id（DM）。先嘗試當頻道解析。
    try {
      const channel = await this.tryResolveTextChannel(msg.targetId);
      if (channel) {
        await channel.send({ content: text || undefined, files: attachments, embeds });
        console.log(LOG, `send ok: channel=${channel.id} parts=${msg.parts.length}`);
        return { ok: true };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(LOG, `頻道發送失敗 [${msg.targetId}]，改走 DM:`, reason);
    }

    // 非頻道 → 視為 DM
    try {
      const user = await this.client.users.fetch(msg.targetId);
      await user.send({ content: text || undefined, files: attachments, embeds });
      console.log(LOG, `send ok (DM): target=${msg.targetId} parts=${msg.parts.length}`);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(LOG, `send 失敗 [${msg.targetId}]:`, reason);
      return { ok: false, error: reason };
    }
  }

  /** 嘗試把 targetId 當作伺服器文字頻道解析；解析失敗返回 null。 */
  private async tryResolveTextChannel(targetId: string): Promise<BaseGuildTextChannel | null> {
    try {
      const fetched = await this.client!.channels.fetch(targetId);
      // 用 enum 型別判斷（GuildText），避免對 partial channel 呼叫 isTextBased() crash
      if (fetched && fetched.type === ChannelType.GuildText) {
        return fetched as BaseGuildTextChannel;
      }
      return null;
    } catch {
      return null;
    }
  }

  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().discord;
    if (!settings.enabled) {
      return { enabled: false, phase: "offline", message: "未啟用" };
    }
    if (!settings.token) {
      return { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
    }
    return this.status;
  }

  /** 給外部：觸發重建（用戶改了 token 後調用）。 */
  public async rebuild(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

/** 從訊息中移除對 Bot 的 @ 提及，只保留純文字內容。 */
function stripBotMention(content: string, botId: string): string {
  // Discord 的提及格式：<@123>（一般）或 <@!123>（舊式 / nickname）
  const mentionRegex = new RegExp(`<@!?${escapeRegex(botId)}>`, "g");
  return content.replace(mentionRegex, " ").replace(/\s+/g, " ").trim();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 遮罩 API Key：顯示前 4 + 尾 4，中間以 * 取代，避免洩漏完整機密。 */
function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}
