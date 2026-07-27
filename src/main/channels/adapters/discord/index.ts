import * as path from "path";
import {
  ActionRowBuilder,
  ApplicationCommandType,
  ApplicationFlags,
  ApplicationIntegrationType,
  EntryPointCommandHandlerType,
  AttachmentBuilder,
  ActivityType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  Partials,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings, saveChannelsSettings, type DiscordChannelConfig } from "../../settings-store";
import { DiscordVoiceCall, parseDiscordVoiceCommand, type DiscordMusicState } from "./voice-call";
import { findDiscordMusicUrl, parseDiscordMusicRequest, resolveDiscordMusicTracks, searchDiscordMusicTracks, type DiscordMusicTrack } from "./music-source";
import { toTraditionalTaiwan } from "../../../utils/opencc";
import {
  buildDiscordMusicPlayer,
  buildDiscordMusicQueue,
  buildDiscordMusicHistory,
  buildDiscordMusicFavorites,
  buildDiscordSpotifyPlaylists,
  buildDiscordSpotifyArtists,
  buildDiscordHelp,
  buildDiscordMusicSearchResults,
  DISCORD_MUSIC_BUTTON_PREFIX,
  DISCORD_SLASH_COMMANDS,
  musicRequestFromButton,
} from "./slash-commands";
import { loadDiscordMusicHistory } from "./music-history";
import { deleteDiscordMusicFavorites, loadDiscordMusicFavorites, moveDiscordMusicFavorite, saveDiscordMusicFavorite, type DiscordMusicFavoriteEntry } from "./music-favorites";
import { getSpotifyArtistTopTracks, getSpotifyPlaylists, getSpotifyPlaylistTracks, searchSpotifyArtists } from "../../spotify-control";
import {
  createCodexImageJob,
  listCodexImageDeliveries,
  markCodexImageDeliveryProcessed,
  validateCodexImageOutput,
} from "./codex-image-queue";
import { enqueueOnDemandCodexImageWorker } from "./codex-image-worker";

const LOG = "[DiscordAdapter]";

export interface DiscordBotProfile {
  connected: boolean;
  id?: string;
  username?: string;
  tag?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  applicationId?: string;
  guildCount: number;
  guilds: Array<{ id: string; name: string }>;
  presenceStatus?: string;
  activityText?: string;
  voiceActive: boolean;
}

export interface DiscordBotProfileUpdate {
  username?: string;
  avatar?: Buffer;
  banner?: Buffer;
  status?: "online" | "idle" | "dnd" | "invisible";
  activityText?: string;
}

export interface DiscordMusicControlInput {
  command: "previous" | "pause" | "resume" | "skip" | "stop" | "repeat-track" | "repeat-queue" | "repeat-off" | "shuffle" | "ordered" | "clear" | "remove" | "volume" | "refresh" | "autoplay-on" | "autoplay-off";
  value?: number;
}

export const DISCORD_ACTIVITY_ENTRY_POINT = {
  name: "launch",
  description: "由昔漣開啟《繩結同行》",
  type: ApplicationCommandType.PrimaryEntryPoint,
  handler: EntryPointCommandHandlerType.DiscordLaunchActivity,
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
} as const;

const DISCORD_CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: true,
  maxTextLength: 2000,
};

function isAllowed(list: string[] | undefined, id: string | null): boolean {
  return !list?.length || (!!id && list.includes(id));
}

export function shouldHandleDiscordInteraction(
  interaction: { user: { id: string }; guildId: string | null; channelId: string | null },
  config: DiscordChannelConfig,
): boolean {
  if (!isAllowed(config.allowedUserIds, interaction.user.id)) return false;
  if (!isAllowed(config.allowedChannelIds, interaction.channelId)) return false;
  if (interaction.guildId && !isAllowed(config.allowedGuildIds, interaction.guildId)) return false;
  return true;
}

export function shouldHandleDiscordMessage(
  message: Pick<Message, "author" | "guildId" | "channelId" | "mentions" | "content">,
  config: DiscordChannelConfig,
  botUserId: string,
): boolean {
  if (message.author.bot) return false;
  if (!isAllowed(config.allowedUserIds, message.author.id)) return false;
  if (!isAllowed(config.allowedChannelIds, message.channelId)) return false;
  if (message.guildId && !isAllowed(config.allowedGuildIds, message.guildId)) return false;
  const invokedWithSlash = message.content.trimStart().startsWith("/");
  if (
    message.guildId
    && config.requireMention !== false
    && !message.mentions.users.has(botUserId)
    && !invokedWithSlash
  ) return false;
  return true;
}

export function isCodexImageOwner(config: DiscordChannelConfig, userId: string): boolean {
  return Boolean(config.codexImageOwnerId && config.codexImageOwnerId === userId);
}

export function extractOwnerCodexImageRequest(
  text: string,
  config: DiscordChannelConfig,
  userId: string,
): string | null {
  if (!isCodexImageOwner(config, userId)) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1800) return null;
  const cyreneFirstPerson = /^(?:我想看你|想看你|讓我看看你)(?:穿|換上|換成|戴|拿著|抱著|躺|坐|站|在|做)/;
  // 「我想看白絲」這類省略「你穿」的說法，在角色對話中仍是明確的服裝生圖請求。
  const cyreneImplicitOutfit = /^(?:我想看|想看|讓我看看)(?:你)?\s*(?:黑絲|白絲|絲襪|褲襪|網襪|過膝襪|長襪|泳裝|睡衣|制服|女僕裝|禮服|裙裝|洋裝)(?:$|[，。！？~～♪]|\s)/i;
  const explicitImage = /(?:幫我|請|可以|能不能|替我|給我|來一張|生成|產生|畫|繪製|做一張).{0,18}(?:圖片|照片|插畫|圖像|繪圖|桌布|壁紙|頭像|立繪|角色圖)/i;
  const imperativeDraw = /^(?:幫我|請|替我)?\s*(?:畫|繪製|生成|產生|做)(?:一張|張)?\s*.+/i;
  return cyreneFirstPerson.test(normalized) || cyreneImplicitOutfit.test(normalized) || explicitImage.test(normalized) || imperativeDraw.test(normalized)
    ? normalized
    : null;
}

/** 以昔漣的原作語氣回覆正在準備圖片，避免顯示生硬的系統佇列文案。 */
export function buildCyreneImageQueuedReply(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (/(?:穿|換上|換成|服裝|衣服|裙|禮服|制服|睡衣|泳裝|絲襪|黑絲|白絲|褲襪)/i.test(normalized)) {
    return [
      "嗯……等我一下喔，我正在換衣服呢。可不許偷看呀♪",
      "等人家準備好，就把這片小小的「記憶」送到你手上。",
    ].join("\n");
  }
  if (/(?:躺|坐|站|跪|抱|拿著|牽手|回眸|跳舞|姿勢|動作)/i.test(normalized)) {
    return [
      "好呀，稍等我一下……人家正在想，要用什麼模樣出現在你眼前呢♪",
      "等這道光凝成畫面，我就帶著它回來找你。",
    ].join("\n");
  }
  if (/(?:花園|星空|房間|臥室|海邊|街道|咖啡|教室|場景|背景|夜晚|黃昏)/i.test(normalized)) {
    return [
      "等我一下呀，我先去你說的那片風景裡走一走。",
      "等星光和花瓣都落在對的位置，我就把它帶回來給你♪",
    ].join("\n");
  }
  return [
    "好呀……等我把你的願望，慢慢織成一幅畫。",
    "稍等人家一下，等這圈漣漪有了模樣，我就回來找你♪",
  ].join("\n");
}

/** 移除 @Bot 或文字消息開頭的單一 `/` 呼叫前綴。 */
export function normalizeDiscordInvocationText(content: string, botUserId: string): string {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  const withoutMention = content.replace(mentionPattern, "").trim();
  if (!withoutMention.startsWith("/")) return withoutMention;

  // 這三個是既有的文字模式切換命令，必須保留斜線交給 dispatcher 判斷。
  if (/^\/(study|talk|collab)$/i.test(withoutMention)) return withoutMention.toLowerCase();
  return withoutMention.slice(1).trimStart() || "嗨";
}

function normalizeDiscordMessage(message: Message, botUserId: string): IncomingMessage {
  const attachments: NonNullable<IncomingMessage["attachments"]> = [];
  const attachmentLines: string[] = [];
  for (const item of message.attachments.values()) {
    const mime = item.contentType ?? undefined;
    const kind = mime?.startsWith("image/") ? "image"
      : mime?.startsWith("audio/") ? "audio"
      : mime?.startsWith("video/") ? "video"
      : "file";
    attachments.push({ kind, url: item.url, mime, caption: item.name });
    attachmentLines.push(`[附件: ${item.name} ${item.url}]`);
  }
  const content = normalizeDiscordInvocationText(message.content, botUserId);
  return {
    channel: "discord",
    senderId: message.author.id,
    senderName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    chatId: message.channelId,
    threadId: message.channel.isThread() ? message.channelId : undefined,
    text: [content, ...attachmentLines].filter(Boolean).join("\n") || "[附件]",
    attachments: attachments.length ? attachments : undefined,
    at: message.createdAt,
    _raw: message,
  };
}

function splitText(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function favoriteEntriesToTracks(entries: DiscordMusicFavoriteEntry[]): Promise<DiscordMusicTrack[]> {
  return await Promise.all(entries.map(async (entry, index) => {
    const resolved = /(?:open\.spotify\.com|spotify\.link)/i.test(entry.url)
      ? (await resolveDiscordMusicTracks(entry.url))[0]
      : undefined;
    return {
      id: entry.id,
      title: resolved?.title ?? entry.title,
      url: entry.url,
      playbackUrl: resolved?.playbackUrl,
      thumbnail: resolved?.thumbnail ?? entry.thumbnail,
      playlistTitle: "我的收藏歌單",
      duration: resolved?.duration ?? entry.duration,
      index: index + 1,
      total: entries.length,
    };
  }));
}

export async function launchCyreneDiscordGame(
  interaction: { launchActivity(): Promise<unknown> },
): Promise<void> {
  await interaction.launchActivity();
}

export function hasDiscordActivityEnabled(application: unknown): boolean {
  if (!application || typeof application !== "object") return false;
  const data = application as { embedded_activity_config?: unknown; flags?: unknown };
  const hasConfig = Boolean(data.embedded_activity_config && typeof data.embedded_activity_config === "object");
  const flags = typeof data.flags === "number" ? data.flags : 0;
  return hasConfig || (flags & ApplicationFlags.Embedded) === ApplicationFlags.Embedded;
}

export function buildDiscordActivityInstallConfig(application: unknown): Record<string, unknown> {
  const data = application && typeof application === "object"
    ? application as { integration_types_config?: Record<string, { oauth2_install_params?: { scopes?: string[]; permissions?: string } }>; install_params?: { scopes?: string[]; permissions?: string } }
    : {};
  const guildParams = data.integration_types_config?.["0"]?.oauth2_install_params ?? data.install_params;
  return {
    integration_types_config: {
      "0": {
        oauth2_install_params: {
          scopes: [...new Set([...(guildParams?.scopes ?? []), "bot", "applications.commands"])],
          permissions: guildParams?.permissions ?? "0",
        },
      },
      "1": {
        oauth2_install_params: {
          scopes: ["applications.commands"],
          permissions: "0",
        },
      },
    },
  };
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  readonly displayName = "Discord";
  readonly capability = DISCORD_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private client: Client | null = null;
  private voiceCall: DiscordVoiceCall | null = null;
  private musicControllerMessage: Message | null = null;
  private musicControllerRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private codexImageBridgeTimer: ReturnType<typeof setInterval> | null = null;
  private codexImageBridgeBusy = false;
  private musicSearchSessions = new Map<string, { ownerId: string; tracks: DiscordMusicTrack[]; expiresAt: number }>();
  private favoriteSelections = new Map<string, string>();
  private discordActivityConfigured = false;
  private status: ChannelStatus = { enabled: false, phase: "offline", message: "未啟用" };

  constructor(private readonly voiceDispatch?: MessageHandler) {}

  async start(): Promise<void> {
    const config = loadChannelsSettings().discord;
    if (!config.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未啟用" };
      return;
    }
    if (!config.botToken) {
      this.status = { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
      return;
    }

    await this.stopClient();
    this.status = { enabled: true, phase: "starting", message: "正在連接 Gateway" };
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    });
    this.client = client;
    this.voiceCall = new DiscordVoiceCall(
      client,
      () => loadChannelsSettings().discord,
      async (msg) => await (this.voiceDispatch ?? this.onMessage)?.(msg) ?? null,
      async (state) => await this.refreshMusicController(state),
    );

    client.on("messageCreate", async (message) => {
      const botUserId = client.user?.id;
      const config = loadChannelsSettings().discord;
      if (!botUserId || !shouldHandleDiscordMessage(message, config, botUserId)) return;
      try {
        const content = normalizeDiscordInvocationText(message.content, botUserId);
        const imageRequest = extractOwnerCodexImageRequest(content, config, message.author.id);
        if (imageRequest) {
          const job = createCodexImageJob({
            prompt: imageRequest,
            requestedByUserId: message.author.id,
            requestedByName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
            responseChannelId: message.channelId,
            responseGuildId: message.guildId,
          });
          await message.reply(buildCyreneImageQueuedReply(job.prompt));
          enqueueOnDemandCodexImageWorker(job);
          return;
        }
        const musicRequest = parseDiscordMusicRequest(content);
        if (musicRequest && await this.voiceCall?.handleMusicRequest(message, musicRequest)) return;
        const voiceCommand = parseDiscordVoiceCommand(content);
        if (voiceCommand && await this.voiceCall?.handleCommand(message, voiceCommand)) return;
        await message.channel.sendTyping().catch(() => undefined);
        await this.onMessage?.(normalizeDiscordMessage(message, botUserId));
      } catch (err) {
        console.error(LOG, "處理入站消息失敗:", err);
      }
    });
    client.on("interactionCreate", async (interaction) => {
      const actionable = interaction.isChatInputCommand() ? interaction
        : interaction.isButton() ? interaction
        : interaction.isStringSelectMenu() ? interaction
        : interaction.isModalSubmit() ? interaction
        : null;
      if (!actionable) return;
      try {
        if (actionable.isChatInputCommand()) await this.handleSlashCommand(actionable);
        else if (actionable.isButton()) await this.handleMusicButton(actionable);
        else if (actionable.isStringSelectMenu()) await this.handleMusicSelect(actionable);
        else await this.handleFavoriteModal(actionable);
      } catch (err) {
        console.error(LOG, "處理 Discord / 指令失敗:", err);
        const content = `指令執行失敗：${err instanceof Error ? err.message : String(err)}`;
        if (actionable.deferred || actionable.replied) await actionable.editReply({ content }).catch(() => undefined);
        else await actionable.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    });
    client.on("guildCreate", (guild) => {
      void guild.commands.set(DISCORD_SLASH_COMMANDS)
        .then(() => console.log(LOG, `已在 ${guild.name} 註冊 ${DISCORD_SLASH_COMMANDS.length} 個 / 指令`))
        .catch((err) => console.warn(LOG, `新伺服器 / 指令註冊失敗 [${guild.name}]:`, err));
    });
    client.on("error", (err) => {
      console.error(LOG, "client error:", err.message);
      this.status = { enabled: true, phase: "error", message: err.message };
    });
    client.on("shardReconnecting", () => {
      this.status = { enabled: true, phase: "starting", message: "Gateway 重新連接中" };
    });
    client.on("shardResume", () => {
      this.status = { enabled: true, phase: "running", message: `已連接：${client.user?.tag ?? "Discord Bot"}` };
    });

    try {
      await client.login(config.botToken);
      await this.refreshDiscordActivityConfiguration(client);
      await this.registerActivityEntryPoint(client);
      await this.registerSlashCommands(client);
      this.startCodexImageBridgeWatcher();
      client.user?.setPresence({
        status: config.presenceStatus ?? "online",
        activities: config.activityText?.trim()
          ? [{ name: config.activityText.trim(), type: ActivityType.Playing }]
          : [],
      });
      this.status = { enabled: true, phase: "running", message: `已連接：${client.user?.tag ?? "Discord Bot"}` };
      console.log(LOG, `Gateway 已連接 (${client.user?.tag ?? "unknown"})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { enabled: true, phase: "error", message };
      await this.stopClient();
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.stopClient();
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  private async stopClient(): Promise<void> {
    this.stopMusicControllerRefresh();
    this.stopCodexImageBridgeWatcher();
    this.musicControllerMessage = null;
    await this.voiceCall?.leave();
    this.voiceCall = null;
    if (!this.client) return;
    this.client.removeAllListeners();
    this.client.destroy();
    this.client = null;
  }

  getStatus(): ChannelStatus {
    const config = loadChannelsSettings().discord;
    if (!config.enabled) return { enabled: false, phase: "offline", message: "未啟用" };
    if (!config.botToken) return { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
    if (this.client?.isReady() && this.status.phase !== "running") {
      this.status = { enabled: true, phase: "running", message: `已連接：${this.client.user?.tag ?? "Discord Bot"}` };
    }
    return this.status;
  }

  async rebuild(): Promise<void> {
    await this.stopClient();
    await this.start();
  }

  private async registerSlashCommands(client: Client): Promise<void> {
    const results = await Promise.allSettled([...client.guilds.cache.values()].map(async (guild) => {
      await guild.commands.set(DISCORD_SLASH_COMMANDS);
      console.log(LOG, `已在 ${guild.name} 註冊 ${DISCORD_SLASH_COMMANDS.length} 個 / 指令`);
    }));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) console.warn(LOG, `${failures.length} 個伺服器無法註冊 / 指令`);
  }

  private async registerActivityEntryPoint(client: Client): Promise<void> {
    if (!this.discordActivityConfigured || !client.application) return;
    try {
      const commands = await client.application.commands.fetch();
      const existing = commands.find((command) => command.type === ApplicationCommandType.PrimaryEntryPoint);
      const registered = existing
        ? await existing.edit(DISCORD_ACTIVITY_ENTRY_POINT)
        : await client.application.commands.create(DISCORD_ACTIVITY_ENTRY_POINT);
      console.log(
        LOG,
        `已註冊 Discord Activity Entry Point：${registered.name} (id=${registered.id}, type=${registered.type}, handler=${registered.handler}, integrations=${registered.integrationTypes?.join(",") ?? "-"}, contexts=${registered.contexts?.join(",") ?? "-"})`,
      );
    } catch (error) {
      console.warn(LOG, "Discord Activity Entry Point 註冊失敗:", error);
    }
  }

  private async refreshDiscordActivityConfiguration(client: Client): Promise<void> {
    try {
      const application = await client.rest.get(Routes.currentApplication());
      this.discordActivityConfigured = hasDiscordActivityEnabled(application);
      if (!this.discordActivityConfigured) {
        console.warn(LOG, "Discord Activity 尚未在 Developer Portal 啟用；/game 將顯示設定提示");
      } else {
        await client.rest.patch(Routes.currentApplication(), { body: buildDiscordActivityInstallConfig(application) });
        console.log(LOG, "已啟用 Discord Activity 的伺服器／使用者安裝範圍與 application.commands");
      }
    } catch (error) {
      this.discordActivityConfigured = false;
      console.warn(LOG, "無法讀取 Discord Activity 設定；/game 將顯示設定提示:", error);
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    // Discord interactions must be acknowledged within roughly three seconds. /play may
    // parse large Bilibili collections, so acknowledge it before any disk/config work.
    const playPredeferred = interaction.commandName === "play" || interaction.commandName === "like" || interaction.commandName === "favorites";
    if (interaction.commandName === "draw") await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else if (playPredeferred) await interaction.deferReply();
    const config = loadChannelsSettings().discord;
    if (!shouldHandleDiscordInteraction(interaction, config)) {
      const content = "你不在 Cyrene 的 Discord 白名單中，或這個頻道／伺服器未被允許。";
      if (interaction.deferred) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === "chat") {
      await this.handleSlashChat(interaction, interaction.options.getString("message", true));
      return;
    }
    if (interaction.commandName === "draw") {
      if (!isCodexImageOwner(config, interaction.user.id)) {
        await interaction.editReply({ content: "這個 Codex 繪圖入口只開放給擁有者。" });
        return;
      }
      const job = createCodexImageJob({
        prompt: interaction.options.getString("prompt", true),
        requestedByUserId: interaction.user.id,
        requestedByName: interaction.user.globalName ?? interaction.user.username,
        responseChannelId: interaction.channelId,
        responseGuildId: interaction.guildId,
      });
      await interaction.editReply({
        content: buildCyreneImageQueuedReply(job.prompt),
      });
      enqueueOnDemandCodexImageWorker(job);
      return;
    }
    if (interaction.commandName === "game") {
      if (!this.discordActivityConfigured) {
        await interaction.reply({
          content: [
            "《繩結同行》尚未在 Discord Developer Portal 完成 Activity 設定。",
            "請先新增 HTTPS URL Mapping 並開啟 **Enable Activities**，再重新連接昔漣。",
          ].join("\n"),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await launchCyreneDiscordGame(interaction);
      return;
    }
    if (interaction.commandName === "status") {
      const client = this.client;
      await interaction.reply({
        content: [
          `🟢 **${client?.user?.username ?? "Cyrene"} 已連線**`,
          `延遲：${Math.max(0, Math.round(client?.ws.ping ?? 0))} ms`,
          `所在伺服器：${client?.guilds.cache.size ?? 0}`,
          `語音狀態：${this.voiceCall?.getSessionSummary() ?? "未啟用"}`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === "help") {
      await interaction.reply({
        ...buildDiscordHelp({
          username: this.client?.user?.username,
          avatarUrl: this.client?.user?.displayAvatarURL({ size: 256 }),
        }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "nowplaying") {
      await interaction.deferReply();
      if (this.voiceCall?.getMusicState().active) await this.showMusicController(interaction);
      else await interaction.editReply({ content: "目前沒有正在播放的音樂，請先使用 `/play`。" });
      return;
    }

    if (interaction.commandName === "queue") {
      const state = this.voiceCall?.getMusicState();
      await interaction.reply(state?.active
        ? { ...buildDiscordMusicQueue(state), flags: MessageFlags.Ephemeral }
        : { content: "目前沒有正在播放的音樂，請先使用 `/play`。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "history") {
      await interaction.reply({ ...buildDiscordMusicHistory(await loadDiscordMusicHistory(25)), flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === "favorites") {
      if (this.voiceCall?.getMusicState().active && !this.voiceCall.canControlMusic(interaction.user.id)) {
        await interaction.editReply({ content: "這是其他人的播放工作階段，你不能播放她的收藏歌單。" });
        return;
      }
      const favorites = await loadDiscordMusicFavorites(500);
      if (!favorites.length) {
        await interaction.editReply({ content: "收藏歌單目前是空的；可以用 `/like` 或播放器的 ❤️ Like 加入歌曲。" });
        return;
      }
      const message = await this.interactionAsMessage(interaction);
      const handled = await this.voiceCall?.handleResolvedMusicTracks(message, await favoriteEntriesToTracks(favorites)) ?? false;
      if (!handled || !this.voiceCall?.getMusicState().active) {
        await interaction.editReply({ content: "無法開始播放，請先加入一個語音頻道。" });
        return;
      }
      await this.showMusicController(interaction);
      return;
    }
    if (interaction.commandName === "spotify") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const artist = interaction.options.getString("artist")?.trim();
        await interaction.editReply(artist
          ? buildDiscordSpotifyArtists(artist, await searchSpotifyArtists(artist, 10))
          : buildDiscordSpotifyPlaylists(await getSpotifyPlaylists(25)));
      } catch (error) {
        await interaction.editReply({ content: `無法讀取 Spotify 播放清單：${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    if (interaction.commandName === "save") {
      const state = this.voiceCall?.getMusicState();
      if (!state?.current) {
        await interaction.reply({ content: "目前沒有正在播放的歌曲。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!this.voiceCall?.canControlMusic(interaction.user.id)) {
        await interaction.reply({ content: "這是其他人的播放工作階段，你不能修改她的收藏。", flags: MessageFlags.Ephemeral });
        return;
      }
      const saved = await saveDiscordMusicFavorite(state.current);
      await interaction.reply({
        content: saved.added ? `❤️ 已將「${saved.entry.title}」加入收藏。` : `「${saved.entry.title}」已經在收藏中。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === "like") {
      if (!this.voiceCall?.canControlMusic(interaction.user.id)) {
        await interaction.editReply({ content: "這是其他人的播放工作階段，你不能修改她的收藏。" });
        return;
      }
      try {
        const input = interaction.options.getString("url")?.trim();
        const track = input
          ? (await resolveDiscordMusicTracks(findDiscordMusicUrl(input) ?? input))[0]
          : this.voiceCall?.getMusicState().current;
        if (!track) {
          await interaction.editReply({ content: input ? "這個連結沒有找到可收藏的歌曲。" : "目前沒有正在播放的歌曲，請貼上單曲連結。" });
          return;
        }
        const saved = await saveDiscordMusicFavorite(track);
        await interaction.editReply({
          content: saved.added ? `❤️ 已將「${saved.entry.title}」加入單曲收藏。` : `「${saved.entry.title}」已經在收藏中。`,
        });
      } catch (error) {
        await interaction.editReply({ content: `無法收藏這個連結：${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }

    const musicSessionActive = this.voiceCall?.getMusicState().active ?? false;
    const musicCommands = new Set(["play", "previous", "pause", "resume", "next", "stop", "queue", "clear", "remove", "volume", "repeat", "mode", "autoplay", "leave"]);
    if (musicSessionActive && musicCommands.has(interaction.commandName) && !this.voiceCall?.canControlMusic(interaction.user.id)) {
      const content = "這是其他人的播放工作階段，你不能控制她的音樂。";
      if (interaction.deferred) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    if (!playPredeferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await this.interactionAsMessage(interaction);
    if (interaction.commandName === "join") {
      await this.voiceCall?.handleCommand(message, "join");
      return;
    }
    if (interaction.commandName === "leave") {
      await this.voiceCall?.handleCommand(message, "leave");
      return;
    }

    const request = this.musicRequestFromInteraction(interaction);
    if (!request) {
      await interaction.editReply({ content: "找不到這個指令的功能。" });
      return;
    }
    if (interaction.commandName === "play" && request.url && !findDiscordMusicUrl(request.url)) {
      const tracks = await searchDiscordMusicTracks(request.url, 5);
      if (!tracks.length) {
        await interaction.editReply({ content: "找不到符合的歌曲，請換一組關鍵字。" });
        return;
      }
      const sessionId = interaction.id;
      this.musicSearchSessions.set(sessionId, {
        ownerId: interaction.user.id,
        tracks,
        expiresAt: Date.now() + 10 * 60_000,
      });
      await interaction.editReply(buildDiscordMusicSearchResults(request.url, tracks, sessionId));
      return;
    }
    if (request.command && request.command !== "queue") {
      const result = this.voiceCall
        ? await this.voiceCall.controlMusic(request.command, request.value)
        : { ok: false, message: "Discord 語音尚未啟用。" };
      if (result.ok) await interaction.deleteReply().catch(() => undefined);
      else await interaction.editReply({ content: result.message });
      return;
    }
    const handled = await this.voiceCall?.handleMusicRequest(message, request) ?? false;
    if (handled && interaction.commandName === "play" && this.voiceCall?.getMusicState().active) {
      await this.showMusicController(interaction);
    }
    if (!handled) {
      await interaction.editReply({ content: "目前沒有正在播放的音樂，請先使用 `/play`。" });
    }
  }

  private startCodexImageBridgeWatcher(): void {
    this.stopCodexImageBridgeWatcher();
    void this.flushCodexImageDeliveries();
    this.codexImageBridgeTimer = setInterval(() => void this.flushCodexImageDeliveries(), 5_000);
  }

  private stopCodexImageBridgeWatcher(): void {
    if (this.codexImageBridgeTimer) clearInterval(this.codexImageBridgeTimer);
    this.codexImageBridgeTimer = null;
    this.codexImageBridgeBusy = false;
  }

  private async flushCodexImageDeliveries(): Promise<void> {
    if (this.codexImageBridgeBusy || !this.client?.isReady()) return;
    this.codexImageBridgeBusy = true;
    try {
      const config = loadChannelsSettings().discord;
      const ownerId = config.codexImageOwnerId;
      if (!ownerId) return;
      for (const delivery of listCodexImageDeliveries()) {
        if (delivery.job.requestedByUserId !== ownerId) {
          console.warn(LOG, `拒絕非擁有者 Codex 圖片結果：${delivery.job.id}`);
          markCodexImageDeliveryProcessed(delivery);
          continue;
        }
        const owner = await this.client.users.fetch(ownerId);
        const responseChannel = delivery.job.responseGuildId && delivery.job.responseChannelId
          ? await this.client.channels.fetch(delivery.job.responseChannelId)
          : null;
        if (delivery.job.responseGuildId) {
          if (!responseChannel || !responseChannel.isSendable() || responseChannel.isDMBased()) {
            throw new Error(`原始 Discord 頻道無法回傳圖片：${delivery.job.responseChannelId ?? "missing"}`);
          }
          if (responseChannel.guildId !== delivery.job.responseGuildId) {
            throw new Error("Discord 回傳頻道與原始伺服器不一致。");
          }
        }
        if (delivery.result.status === "completed" && delivery.result.imagePath) {
          const imagePath = validateCodexImageOutput(delivery.result.imagePath);
          const payload = {
            content: "我回來啦♪ 你想看的模樣，已經好好留在這片「記憶」裡了。",
            files: [new AttachmentBuilder(imagePath, { name: path.basename(imagePath) })],
          };
          if (responseChannel?.isSendable()) await responseChannel.send(payload);
          else await owner.send(payload);
        } else {
          const failureMessage = [
            "唔……這次的光沒有好好凝成畫面。再讓人家試一次，好嗎？",
            `（${delivery.result.error || "沒有取得圖片"}）`,
          ].join("\n");
          if (responseChannel?.isSendable()) await responseChannel.send(failureMessage);
          else await owner.send(failureMessage);
        }
        markCodexImageDeliveryProcessed(delivery);
      }
    } catch (error) {
      console.error(LOG, "回傳 Codex 圖片失敗:", error);
    } finally {
      this.codexImageBridgeBusy = false;
    }
  }

  private async handleMusicButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-`)) {
      await this.handleFavoriteEditorButton(interaction);
      return;
    }
    const state = this.voiceCall?.getMusicState();
    const request = musicRequestFromButton(
      interaction.customId,
      state?.paused ?? false,
      state?.shuffle ?? false,
      state?.repeat ?? "off",
      state?.autoplay ?? false,
      state?.volume ?? 100,
    );
    if (!request) return;
    const config = loadChannelsSettings().discord;
    const playlistOnly = request.command === "queue";
    const passiveAction = playlistOnly || request.command === "refresh";
    const accessConfig = passiveAction ? { ...config, allowedUserIds: undefined } : config;
    if (!shouldHandleDiscordInteraction(interaction, accessConfig)) {
      await interaction.reply({ content: "你沒有操作這個 Bot 的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!passiveAction && !this.voiceCall?.canControlMusic(interaction.user.id)) {
      await interaction.reply({ content: "這是其他人的播放工作階段，你不能使用這些控制按鈕。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (request.command === "queue") {
      await interaction.reply(state?.active
        ? { ...buildDiscordMusicQueue(state), flags: MessageFlags.Ephemeral }
        : { content: "目前沒有正在播放的音樂。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (request.command === "history") {
      await interaction.reply({ ...buildDiscordMusicHistory(await loadDiscordMusicHistory(25)), flags: MessageFlags.Ephemeral });
      return;
    }
    if (request.command === "favorites") {
      await interaction.reply({ ...buildDiscordMusicFavorites(await loadDiscordMusicFavorites(100)), flags: MessageFlags.Ephemeral });
      return;
    }
    if (request.command === "favorite") {
      if (!state?.current) {
        await interaction.reply({ content: "目前沒有正在播放的歌曲。", flags: MessageFlags.Ephemeral });
        return;
      }
      const saved = await saveDiscordMusicFavorite(state.current);
      await interaction.reply({
        content: saved.added ? `❤️ 已將「${saved.entry.title}」加入收藏。` : `「${saved.entry.title}」已經在收藏中。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (request.command === "refresh") {
      await interaction.deferUpdate();
      this.musicControllerMessage = interaction.message;
      if (state) await interaction.editReply(buildDiscordMusicPlayer(state));
      return;
    }
    await interaction.deferUpdate();
    this.musicControllerMessage = interaction.message;
    const result = this.voiceCall
      ? await this.voiceCall.controlMusic(request.command!, request.value)
      : { ok: false, message: "Discord 語音尚未啟用。" };
    if (result.ok && this.voiceCall) await interaction.editReply(buildDiscordMusicPlayer(this.voiceCall.getMusicState()));
    if (!result.ok) await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
  }

  private async handleFavoriteEditorButton(interaction: ButtonInteraction): Promise<void> {
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有編輯收藏歌單的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    const action = interaction.customId.slice(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-`.length);
    if (action === "add") {
      const input = new TextInputBuilder()
        .setCustomId("url")
        .setLabel("Music URL")
        .setPlaceholder("Bilibili / YouTube / Spotify 單曲連結")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      await interaction.showModal(new ModalBuilder()
        .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-add-modal`)
        .setTitle("Add to favorites")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    if (action === "delete") {
      const input = new TextInputBuilder()
        .setCustomId("numbers")
        .setLabel("Track numbers")
        .setPlaceholder("例如：1 2 3 4（用空格分隔）")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      await interaction.showModal(new ModalBuilder()
        .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-delete-modal`)
        .setTitle("Delete from playlists")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    const selectedId = this.favoriteSelections.get(interaction.user.id);
    if (!selectedId) {
      await interaction.reply({ content: "請先從上方選單選擇一首歌曲。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    if (action === "up" || action === "down") {
      await moveDiscordMusicFavorite(selectedId, action);
    }
    await interaction.editReply(buildDiscordMusicFavorites(await loadDiscordMusicFavorites(100)));
  }

  private async handleFavoriteModal(interaction: ModalSubmitInteraction): Promise<void> {
    const isAdd = interaction.customId === `${DISCORD_MUSIC_BUTTON_PREFIX}favorites-add-modal`;
    const isDelete = interaction.customId === `${DISCORD_MUSIC_BUTTON_PREFIX}favorites-delete-modal`;
    if (!isAdd && !isDelete) return;
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有編輯收藏歌單的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (isDelete) {
        const raw = interaction.fields.getTextInputValue("numbers").trim();
        const tokens = raw.split(/\s+/).filter(Boolean);
        if (!tokens.length || tokens.some((token) => !/^\d+$/.test(token))) {
          await interaction.editReply({ content: "請輸入歌曲編號，並用空格分隔，例如：`1 2 3 4`。" });
          return;
        }
        const favorites = await loadDiscordMusicFavorites(100);
        const visibleCount = Math.min(25, favorites.length);
        const numbers = [...new Set(tokens.map(Number))];
        const invalid = numbers.filter((number) => number < 1 || number > visibleCount);
        if (invalid.length) {
          await interaction.editReply({ content: `找不到編號 ${invalid.join("、")}；目前可選範圍是 1–${visibleCount}。` });
          return;
        }
        const ids = numbers.map((number) => favorites[number - 1].id);
        const deleted = await deleteDiscordMusicFavorites(ids);
        const selectedId = this.favoriteSelections.get(interaction.user.id);
        if (selectedId && ids.includes(selectedId)) this.favoriteSelections.delete(interaction.user.id);
        if (interaction.message) {
          await interaction.message.edit(buildDiscordMusicFavorites(await loadDiscordMusicFavorites(100))).catch(() => undefined);
        }
        await interaction.editReply({ content: `已刪除 ${deleted} 首歌曲。` });
        return;
      }
      const input = interaction.fields.getTextInputValue("url").trim();
      const track = (await resolveDiscordMusicTracks(findDiscordMusicUrl(input) ?? input))[0];
      if (!track) {
        await interaction.editReply({ content: "這個連結沒有找到可收藏的歌曲。" });
        return;
      }
      const saved = await saveDiscordMusicFavorite(track);
      if (interaction.message) {
        await interaction.message.edit(buildDiscordMusicFavorites(await loadDiscordMusicFavorites(100))).catch(() => undefined);
      }
      await interaction.editReply({ content: saved.added ? `❤️ 已加入「${saved.entry.title}」。` : `「${saved.entry.title}」已經在收藏中。` });
    } catch (error) {
      await interaction.editReply({ content: `無法加入收藏：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async handleMusicSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId.startsWith("cyrene:music:search:")) {
      await this.handleMusicSearchSelect(interaction);
      return;
    }
    if (interaction.customId === "cyrene:music:favorites-select") {
      await this.handleMusicFavoriteSelect(interaction);
      return;
    }
    if (interaction.customId === "cyrene:music:spotify-select") {
      await this.handleSpotifyPlaylistSelect(interaction);
      return;
    }
    if (interaction.customId === "cyrene:music:spotify-artist-select") {
      await this.handleSpotifyArtistSelect(interaction);
      return;
    }
    if (interaction.customId !== "cyrene:music:volume") return;
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有操作這個 Bot 的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.voiceCall?.canControlMusic(interaction.user.id)) {
      await interaction.reply({ content: "這是其他人的播放工作階段，你不能調整音量。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    this.musicControllerMessage = interaction.message;
    const value = Number.parseInt(interaction.values[0] ?? "100", 10);
    const result = this.voiceCall
      ? await this.voiceCall.controlMusic("volume", value)
      : { ok: false, message: "Discord 語音尚未啟用。" };
    if (result.ok && this.voiceCall) await interaction.editReply(buildDiscordMusicPlayer(this.voiceCall.getMusicState()));
    if (!result.ok) await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
  }

  private async handleMusicSearchSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const sessionId = interaction.customId.slice("cyrene:music:search:".length);
    const session = this.musicSearchSessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      this.musicSearchSessions.delete(sessionId);
      await interaction.reply({ content: "這份搜尋結果已過期，請重新使用 `/play`。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (session.ownerId !== interaction.user.id) {
      await interaction.reply({ content: "只有發起搜尋的人可以選擇歌曲。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有操作這個 Bot 的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    const index = Number.parseInt(interaction.values[0] ?? "-1", 10);
    const track = session.tracks[index];
    if (!track) {
      await interaction.reply({ content: "找不到這首歌曲，請重新搜尋。", flags: MessageFlags.Ephemeral });
      return;
    }
    this.musicSearchSessions.delete(sessionId);
    await interaction.deferUpdate();
    await interaction.editReply({ content: `🔎 正在讀取「${track.title}」…`, embeds: [], components: [] });
    const message = await this.interactionAsMessage(interaction);
    const handled = await this.voiceCall?.handleMusicRequest(message, { url: track.url }) ?? false;
    if (!handled || !this.voiceCall?.getMusicState().active) {
      await interaction.editReply({ content: "無法開始播放，請確認你已加入語音頻道。", embeds: [], components: [] });
      return;
    }
    this.musicControllerMessage = interaction.message;
    await this.showMusicController(interaction);
    this.startMusicControllerRefresh();
  }

  private async handleMusicFavoriteSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有操作這個 Bot 的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.voiceCall?.getMusicState().active && !this.voiceCall.canControlMusic(interaction.user.id)) {
      await interaction.reply({ content: "這是其他人的播放工作階段，你不能加入歌曲。", flags: MessageFlags.Ephemeral });
      return;
    }
    const favorites = await loadDiscordMusicFavorites(500);
    const selectedIndex = favorites.findIndex((entry) => entry.id === interaction.values[0]);
    if (selectedIndex < 0) {
      await interaction.reply({ content: "找不到這筆收藏，請重新開啟 `/favorites`。", flags: MessageFlags.Ephemeral });
      return;
    }
    this.favoriteSelections.set(interaction.user.id, favorites[selectedIndex].id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await this.interactionAsMessage(interaction);
    const playable = await favoriteEntriesToTracks(favorites.slice(selectedIndex));
    const handled = await this.voiceCall?.handleResolvedMusicTracks(message, playable) ?? false;
    if (!handled || !this.voiceCall?.getMusicState().active) {
      await interaction.editReply({ content: "無法開始播放，請確認你已加入語音頻道。", embeds: [], components: [] });
      return;
    }
    await this.showMusicController(interaction);
  }

  private async handleSpotifyPlaylistSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有操作這個 Bot 的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.voiceCall?.getMusicState().active && !this.voiceCall.canControlMusic(interaction.user.id)) {
      await interaction.reply({ content: "這是其他人的播放工作階段，你不能加入歌曲。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const playlist = (await getSpotifyPlaylists(25)).find((item) => item.id === interaction.values[0]);
      if (!playlist) {
        await interaction.editReply({ content: "找不到這個 Spotify 播放清單，請重新使用 `/spotify`。" });
        return;
      }
      await interaction.editReply({ content: `🔎 正在讀取「${playlist.name}」…` });
      const tracks = await getSpotifyPlaylistTracks(playlist);
      if (!tracks.length) {
        await interaction.editReply({ content: "這份 Spotify 播放清單沒有可播放的歌曲。" });
        return;
      }
      const message = await this.interactionAsMessage(interaction);
      const handled = await this.voiceCall?.handleResolvedMusicTracks(message, tracks) ?? false;
      if (!handled || !this.voiceCall?.getMusicState().active) {
        await interaction.editReply({ content: "無法開始播放，請確認你已加入語音頻道。", embeds: [], components: [] });
        return;
      }
      await this.showMusicController(interaction);
    } catch (error) {
      await interaction.editReply({ content: `Spotify 播放清單讀取失敗：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async handleSpotifyArtistSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!shouldHandleDiscordInteraction(interaction, loadChannelsSettings().discord)) {
      await interaction.reply({ content: "你沒有操作這個 Bot 的權限。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.voiceCall?.getMusicState().active && !this.voiceCall.canControlMusic(interaction.user.id)) {
      await interaction.reply({ content: "這是其他人的播放工作階段，你不能加入歌曲。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await interaction.editReply({ content: "🔎 正在讀取作者的熱門歌曲…" });
      const tracks = await getSpotifyArtistTopTracks(interaction.values[0] ?? "");
      if (!tracks.length) {
        await interaction.editReply({ content: "這位作者目前沒有可播放的熱門歌曲。" });
        return;
      }
      const message = await this.interactionAsMessage(interaction);
      const handled = await this.voiceCall?.handleResolvedMusicTracks(message, tracks) ?? false;
      if (!handled || !this.voiceCall?.getMusicState().active) {
        await interaction.editReply({ content: "無法開始播放，請確認你已加入語音頻道。", embeds: [], components: [] });
        return;
      }
      await this.showMusicController(interaction);
    } catch (error) {
      await interaction.editReply({ content: `Spotify 作者歌曲讀取失敗：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private stopMusicControllerRefresh(): void {
    if (this.musicControllerRefreshTimer) clearInterval(this.musicControllerRefreshTimer);
    this.musicControllerRefreshTimer = null;
  }

  private startMusicControllerRefresh(): void {
    this.stopMusicControllerRefresh();
    this.musicControllerRefreshTimer = setInterval(() => {
      const state = this.voiceCall?.getMusicState();
      if (state) void this.refreshMusicController(state);
    }, 5_000);
  }

  private async showMusicController(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction): Promise<void> {
    const state = this.voiceCall?.getMusicState();
    if (!state) return;
    const payload = buildDiscordMusicPlayer(state);
    const existing = this.musicControllerMessage;
    let updatedExisting = false;
    if (existing && existing.channelId === interaction.channelId) {
      updatedExisting = await existing.edit(payload).then(() => true).catch(() => false);
      if (!updatedExisting) this.musicControllerMessage = null;
    }
    if (updatedExisting) {
      await interaction.deleteReply().catch(() => undefined);
    } else if (interaction.channel?.isSendable()) {
      const sent = await interaction.channel.send(payload);
      this.musicControllerMessage = sent;
      await interaction.deleteReply().catch(() => undefined);
    } else {
      await interaction.editReply(payload);
      this.musicControllerMessage = await interaction.fetchReply();
    }
    this.startMusicControllerRefresh();
  }

  private async refreshMusicController(state: DiscordMusicState): Promise<void> {
    const message = this.musicControllerMessage;
    if (!message) return;
    try {
      await message.edit(buildDiscordMusicPlayer(state));
      if (!state.active) {
        this.stopMusicControllerRefresh();
        this.musicControllerMessage = null;
      }
    } catch (err) {
      console.warn(LOG, "更新 Discord 音樂播放器失敗:", err);
      this.stopMusicControllerRefresh();
      this.musicControllerMessage = null;
    }
  }

  private musicRequestFromInteraction(interaction: ChatInputCommandInteraction) {
    if (interaction.commandName === "play") {
      const input = interaction.options.getString("url", true);
      return { url: findDiscordMusicUrl(input) ?? input };
    }
    if (interaction.commandName === "pause") return { command: "pause" as const };
    if (interaction.commandName === "resume") return { command: "resume" as const };
    if (interaction.commandName === "previous") return { command: "previous" as const };
    if (interaction.commandName === "next") return { command: "skip" as const };
    if (interaction.commandName === "stop") return { command: "stop" as const };
    if (interaction.commandName === "queue") return { command: "queue" as const };
    if (interaction.commandName === "clear") return { command: "clear" as const };
    if (interaction.commandName === "remove") {
      return { command: "remove" as const, value: interaction.options.getInteger("position", true) };
    }
    if (interaction.commandName === "volume") {
      return { command: "volume" as const, value: interaction.options.getInteger("percent", true) };
    }
    if (interaction.commandName === "repeat") {
      const mode = interaction.options.getString("mode", true);
      return { command: mode === "track" ? "repeat-track" as const : mode === "queue" ? "repeat-queue" as const : "repeat-off" as const };
    }
    if (interaction.commandName === "mode") {
      return { command: interaction.options.getString("type", true) === "shuffle" ? "shuffle" as const : "ordered" as const };
    }
    if (interaction.commandName === "autoplay") {
      return { command: interaction.options.getBoolean("enabled", true) ? "autoplay-on" as const : "autoplay-off" as const };
    }
    return null;
  }

  private async interactionAsMessage(
    interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<Message> {
    const member: GuildMember | null = interaction.guild
      ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
      : null;
    return {
      channelId: interaction.channelId,
      author: interaction.user,
      member,
      reply: async (content: string) => {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({ content });
          return {
            edit: async (next: string) => {
              await interaction.editReply({ content: next });
              return await interaction.fetchReply();
            },
          } as unknown as Message;
        }
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
          return {
            edit: async (next: string) => {
              await interaction.editReply({ content: next });
              return await interaction.fetchReply();
            },
          } as unknown as Message;
        }
        return await interaction.followUp({ content, fetchReply: true, flags: MessageFlags.Ephemeral });
      },
    } as unknown as Message;
  }

  private async handleSlashChat(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
    await interaction.deferReply();
    const member = interaction.guild
      ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
      : null;
    const outgoing = await (this.voiceDispatch ?? this.onMessage)?.({
      channel: "discord",
      senderId: interaction.user.id,
      senderName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
      chatId: interaction.channelId,
      text,
      at: new Date(),
      _raw: { source: "discord-slash", interactionId: interaction.id, guildId: interaction.guildId },
    }) ?? null;
    const reply = outgoing?.parts
      .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!reply) {
      await interaction.editReply("這次沒有取得回覆，請稍後再試一次。");
      return;
    }
    const chunks = splitText(reply);
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
  }

  getProfile(): DiscordBotProfile {
    const client = this.client;
    const user = client?.user;
    const connected = !!client?.isReady() && !!user;
    return {
      connected,
      id: user?.id,
      username: user?.username,
      tag: user?.tag,
      avatarUrl: user?.displayAvatarURL({ extension: "png", size: 256 }),
      bannerUrl: user?.bannerURL({ extension: "png", size: 1024 }) ?? undefined,
      applicationId: client?.application?.id ?? user?.id,
      guildCount: client?.guilds.cache.size ?? 0,
      guilds: client ? [...client.guilds.cache.values()]
        .map((guild) => ({ id: guild.id, name: guild.name }))
        .sort((a, b) => a.name.localeCompare(b.name)) : [],
      presenceStatus: user?.presence?.status,
      activityText: user?.presence?.activities[0]?.name ?? "",
      voiceActive: this.voiceCall?.isActive() ?? false,
    };
  }

  getMusicState(): DiscordMusicState {
    return this.voiceCall?.getMusicState() ?? {
      active: false,
      paused: false,
      current: null,
      queue: [],
      volume: 100,
      repeat: "off",
      shuffle: false,
      autoplay: false,
      elapsed: 0,
    };
  }

  async controlMusic(input: DiscordMusicControlInput): Promise<{ ok: boolean; message: string; state: DiscordMusicState }> {
    const result = this.voiceCall
      ? await this.voiceCall.controlMusic(input.command, input.value)
      : { ok: false, message: "Discord 尚未連接。" };
    return { ...result, state: this.getMusicState() };
  }

  async updateProfile(update: DiscordBotProfileUpdate): Promise<DiscordBotProfile> {
    const client = this.client;
    const user = client?.user;
    if (!client?.isReady() || !user) throw new Error("Discord Gateway 尚未連接");

    const username = update.username ? toTraditionalTaiwan(update.username.trim()) : undefined;
    if (username && username !== user.username) {
      if (username.length < 2 || username.length > 32) throw new Error("Bot 名稱需為 2–32 個字元");
      await user.setUsername(username);
    }
    if (update.avatar) await user.setAvatar(update.avatar);
    if (update.banner) await user.setBanner(update.banner);

    const status = update.status ?? (user.presence?.status === "offline" ? "online" : user.presence?.status) ?? "online";
    const activityText = toTraditionalTaiwan(update.activityText?.trim() ?? "");
    client.user.setPresence({
      status,
      activities: activityText ? [{ name: activityText, type: ActivityType.Playing }] : [],
    });
    saveChannelsSettings({
      discord: {
        enabled: loadChannelsSettings().discord.enabled,
        presenceStatus: status,
        activityText,
      },
    });
    return this.getProfile();
  }

  async send(message: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client?.isReady()) return { ok: false, error: "Discord Gateway 未連接" };
    try {
      const channel = await this.client.channels.fetch(message.targetId);
      if (!channel?.isSendable()) return { ok: false, error: "目標頻道不存在或不可發送" };
      for (const part of message.parts) await this.sendPart(channel, part);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async sendPart(channel: SendableChannels, part: OutgoingPart): Promise<void> {
    if (part.kind === "text") {
      for (const chunk of splitText(part.text)) await channel.send({ content: chunk });
      return;
    }
    if (part.kind === "card") {
      const embed = new EmbedBuilder().setTitle(part.title).setDescription(part.markdown?.slice(0, 4096) || null);
      if (part.fields?.length) embed.addFields(part.fields.slice(0, 25).map((f) => ({ name: f.key, value: f.value.slice(0, 1024), inline: true })));
      await channel.send({ embeds: [embed] });
      return;
    }
    const source = part.kind === "image" ? (part.filePath ?? part.url)
      : part.kind === "sticker" ? part.imagePath
      : part.filePath;
    if (!source) throw new Error(`${part.kind} 沒有可發送的檔案`);
    const attachment = new AttachmentBuilder(source);
    const caption = part.kind === "image" ? part.caption : undefined;
    await channel.send({ content: caption, files: [attachment] });
  }
}
