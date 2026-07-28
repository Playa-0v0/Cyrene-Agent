import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { loadConfig } from "./config.js";
import { mentionsBot, normalizeInvocation, sessionIdFor, shouldHandleMessage, splitDiscordText } from "./core.js";
import { startHealthServer } from "./health.js";
import { generateReply } from "./llm.js";
import { MemoryStore } from "./memory.js";
import { loadSystemPrompt } from "./prompt.js";
import { EventClaimStore } from "./event-claims.js";
import { FavoriteStore } from "./favorites.js";
import { CloudMusicPlayer, extractPlayableUrl } from "./music-player.js";
import { MusicUsageStore } from "./music-usage.js";
import { playOnSpotify } from "./spotify-connect.js";

const config = loadConfig();
const memory = new MemoryStore(config.dataDir, config.historyMessages);
const eventClaims = new EventClaimStore(config.dataDir);
const favorites = new FavoriteStore(`${config.dataDir}/music-favorites.json`);
const music = new CloudMusicPlayer(config.dataDir);
const musicUsage = new MusicUsageStore(`${config.dataDir}/cloud-music-usage.json`, config.musicMonthlyMinutes);
eventClaims.prune();
const systemPrompt = await loadSystemPrompt(config);
const startedAt = Date.now();
const queues = new Map<string, Promise<void>>();
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

function enqueue(sessionId: string, task: () => Promise<void>): void {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task).finally(() => {
    if (queues.get(sessionId) === current) queues.delete(sessionId);
  });
  queues.set(sessionId, current);
}

async function replyToMessage(message: Message, text: string): Promise<void> {
  for (const chunk of splitDiscordText(text)) await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
}

type DiscordImageInput = { url: string; mime?: string; name?: string };

function isSupportedImage(name: string, contentType: string | null): boolean {
  if (contentType && SUPPORTED_IMAGE_MIMES.has(contentType.toLowerCase())) return true;
  return /\.(?:png|jpe?g|webp|gif)$/i.test(name);
}

function imageInputsFromMessage(message: Message): DiscordImageInput[] {
  return [...message.attachments.values()]
    .filter((attachment) => attachment.size <= MAX_IMAGE_BYTES && isSupportedImage(attachment.name, attachment.contentType))
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .map((attachment) => ({ url: attachment.url, mime: attachment.contentType ?? undefined, name: attachment.name }));
}

async function runConversation(sessionId: string, input: string, images: DiscordImageInput[] = []): Promise<string> {
  await memory.append(sessionId, "user", input);
  const reply = await generateReply(config, systemPrompt, memory.get(sessionId), images);
  await memory.append(sessionId, "assistant", reply);
  return reply;
}

function isBlockedMusicAiRequest(input: string): boolean {
  return /(?:搜尋|找|推薦|分析|辨識).{0,12}(?:歌|音樂|歌曲|歌手)|(?:歌|音樂|歌曲|歌手).{0,12}(?:搜尋|推薦|分析)/iu.test(input);
}

function musicLimitMessage(): string {
  return `本月雲端音樂已使用 ${musicUsage.used()}/${config.musicMonthlyMinutes} 分鐘；達到限制後會停止播放，以預留 Google Cloud 免費流量。`;
}

async function voiceChannelFor(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild
    ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
    : null;
  return member?.voice.channel ?? null;
}

async function fastInteractionReply(interaction: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: 4, data: { content, ...(ephemeral ? { flags: 64 } : {}) } }),
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`Discord interaction callback HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function editInteractionReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.applicationId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Discord interaction edit HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

client.on("messageCreate", (message) => {
  if (message.author.bot || !client.user) return;
  const mentioned = message.mentions.users.has(client.user.id) || mentionsBot(message.content, client.user.id);
  const images = imageInputsFromMessage(message);
  const normalizedInput = normalizeInvocation(message.content, client.user.id);
  const input = images.length && normalizedInput === "嗨" ? "請看看我附上的圖片。" : normalizedInput;
  const command = input.trim().toLowerCase().replace(/^[!/]/, "");
  const knownCommand = command === "status" || command === "forget";
  const disabledCommand = /^(?:spotify|bilibili|history|shuffle|repeat|join)$/i.test(command);
  const explicitTextCommand = /^!(status|forget)$/i.test(message.content.trim());
  console.log(`[Discord] 收到訊息：guild=${message.guildId ?? "dm"} channel=${message.channelId} mentioned=${mentioned} command=${knownCommand ? command : "chat"}`);
  const canHandle = shouldHandleMessage({
    userId: message.author.id,
    guildId: message.guildId,
    channelId: message.channelId,
    isDm: !message.guildId,
    mentioned: mentioned || explicitTextCommand,
  }, config);
  if (!canHandle) {
    console.log("[Discord] 已忽略訊息：未通過提及或白名單設定");
    return;
  }
  const sessionId = sessionIdFor(message.author.id, message.channelId);
  enqueue(sessionId, async () => {
    try {
      if (command === "status") {
        await replyToMessage(message, `雲端文字聊天已連線，已守望 ${Math.floor((Date.now() - startedAt) / 60_000)} 分鐘。`);
        return;
      }
      if (disabledCommand) {
        await replyToMessage(message, "雲端版不使用 AI 搜尋、推薦或分析音樂。請使用 `/play` 貼直接網址，或播放既有收藏。");
        return;
      }
      if (command === "forget") {
        await memory.forget(sessionId);
        await replyToMessage(message, "這個頻道的雲端短期對話已清空。");
        return;
      }
      if (isBlockedMusicAiRequest(input)) {
        await replyToMessage(message, "為節省 AI 額度，雲端版不搜尋、推薦或分析音樂；請直接貼網址給 `/play`。");
        return;
      }
      await message.channel.sendTyping().catch(() => undefined);
      await replyToMessage(message, await runConversation(sessionId, input, images));
    } catch (error) {
      console.error("[Discord] 回覆失敗", error);
    }
  });
});

async function handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  console.log(`[Discord] 收到 Slash 指令：/${interaction.commandName}`);
  if (!shouldHandleMessage({
    userId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    isDm: !interaction.guildId,
    mentioned: true,
  }, config)) {
    await fastInteractionReply(interaction, "這個入口目前沒有開放。");
    return;
  }
  const sessionId = sessionIdFor(interaction.user.id, interaction.channelId);
  const cloudCommands = ["chat", "forget", "status", "play", "spotify", "favorites", "like", "queue", "pause", "next", "previous", "leave", "volume"];
  if (!cloudCommands.includes(interaction.commandName)) {
    await fastInteractionReply(interaction, "雲端版不使用 AI 搜尋、推薦或分析音樂；只接受直接網址、既有收藏與固定播放器控制。");
    return;
  }
  if (interaction.commandName === "forget") {
    await memory.forget(sessionId);
    await fastInteractionReply(interaction, "這個頻道的雲端短期對話已清空。");
    return;
  }
  if (interaction.commandName === "status") {
    await fastInteractionReply(interaction, `雲端已連線，已守望 ${Math.floor((Date.now() - startedAt) / 60_000)} 分鐘。\n${musicLimitMessage()}`);
    return;
  }
  if (interaction.commandName === "play") {
    const value = interaction.options.getString("url", true).trim();
    await fastInteractionReply(interaction, "正在連接你的官方 Spotify 裝置…", false);
    try {
      await playOnSpotify(config, value);
      await editInteractionReply(interaction, "🟢 已在你的官方 Spotify 裝置開始播放（Premium 免廣告）。");
    } catch (error) {
      await editInteractionReply(interaction, `Spotify 播放失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (interaction.commandName === "spotify") {
    const value = interaction.options.getString("playlist")?.trim()
      || interaction.options.getString("artist")?.trim();
    if (!value) {
      await fastInteractionReply(interaction, "請輸入 Spotify 歌單連結或作者名稱。");
      return;
    }
    await fastInteractionReply(interaction, "正在連接你的官方 Spotify 裝置…", false);
    try {
      await playOnSpotify(config, value);
      await editInteractionReply(interaction, "🟢 已在你的官方 Spotify 裝置開始播放（Premium 免廣告）。");
    } catch (error) {
      await editInteractionReply(interaction, `Spotify 播放失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (interaction.commandName === "favorites") {
    if (musicUsage.exhausted()) {
      await fastInteractionReply(interaction, musicLimitMessage());
      return;
    }
    const entries = favorites.list(500).reverse();
    if (!entries.length) {
      await fastInteractionReply(interaction, "收藏歌單目前是空的；使用 `/like url:<直接網址>` 新增。");
      return;
    }
    const channel = await voiceChannelFor(interaction);
    if (!channel) {
      await fastInteractionReply(interaction, "請先加入語音頻道，再使用 `/favorites`。");
      return;
    }
    await fastInteractionReply(interaction, "正在播放既有收藏…", false);
    try {
      const first = await music.playFavorites(channel, entries);
      await editInteractionReply(interaction, `▶️ 從 **${first.title}** 開始播放 ${entries.length} 首收藏。\n${musicLimitMessage()}`);
    } catch (error) {
      await editInteractionReply(interaction, `播放失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (interaction.commandName === "like") {
    const value = interaction.options.getString("url")?.trim();
    const current = music.snapshot().current;
    const url = value || current?.url;
    if (!url) {
      await fastInteractionReply(interaction, "請提供直接網址，或先播放一首歌再收藏。");
      return;
    }
    try { extractPlayableUrl(url); } catch {
      await fastInteractionReply(interaction, "只能收藏直接網址；雲端版不會用歌名搜尋。");
      return;
    }
    const saved = await favorites.save(url, current?.url === url ? current.title : undefined);
    await fastInteractionReply(interaction, saved.added ? `❤️ 已收藏：${saved.entry.title}` : `已經收藏過：${saved.entry.title}`);
    return;
  }
  if (interaction.commandName === "queue") {
    const state = music.snapshot();
    const upcoming = state.upcoming.slice(0, 15).map((entry, index) => `${index + 1}. ${entry.title}`).join("\n");
    await fastInteractionReply(interaction, state.current
      ? `正在播放：**${state.current.title}**\n${upcoming ? `接下來：\n${upcoming}` : "佇列已空。"}`
      : "目前沒有播放音樂。");
    return;
  }
  if (interaction.commandName === "pause") {
    const state = music.pauseOrResume();
    await fastInteractionReply(interaction, state === "playing" ? "▶️" : state === "paused" ? "⏸️" : "目前沒有播放音樂。");
    return;
  }
  if (interaction.commandName === "next") {
    await fastInteractionReply(interaction, music.skip() ? "⏭️" : "目前沒有播放音樂。");
    return;
  }
  if (interaction.commandName === "previous") {
    await fastInteractionReply(interaction, music.previous() ? "⏮️" : "沒有可以返回的上一首。");
    return;
  }
  if (interaction.commandName === "leave") {
    music.stop();
    await fastInteractionReply(interaction, "👋");
    return;
  }
  if (interaction.commandName === "volume") {
    const percent = interaction.options.getInteger("percent", true);
    await fastInteractionReply(interaction, `🔊 ${music.setVolume(percent)}%`);
    return;
  }
  const image = interaction.options.getAttachment("image");
  if (image && (image.size > MAX_IMAGE_BYTES || !isSupportedImage(image.name, image.contentType))) {
    await fastInteractionReply(interaction, "圖片需為 PNG、JPEG、WebP 或 GIF，且不可超過 10 MB。");
    return;
  }
  const images: DiscordImageInput[] = image
    ? [{ url: image.url, mime: image.contentType ?? undefined, name: image.name }]
    : [];
  const input = interaction.options.getString("message")?.trim() || (images.length ? "請看看我附上的圖片。" : "");
  if (!input) {
    await fastInteractionReply(interaction, "請輸入訊息或附上一張圖片。");
    return;
  }
  if (isBlockedMusicAiRequest(input)) {
    await fastInteractionReply(interaction, "為節省 AI 額度，雲端版不搜尋、推薦或分析音樂；請直接貼網址給 `/play`。");
    return;
  }
  await interaction.deferReply();
  try {
    const chunks = splitDiscordText(await runConversation(sessionId, input, images));
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
  } catch (error) {
    console.error("[Discord] 指令回覆失敗", error);
    await interaction.editReply("雲層暫時擋住了訊息，請稍後再試一次。");
  }
}

client.on("interactionCreate", (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (!eventClaims.claim(interaction.id)) {
      console.log(`[Discord] 已忽略重複 interaction：${interaction.id}`);
      return;
    }
    void handleSlash(interaction).catch(async (error) => {
      console.error("[Discord] 指令處理失敗", error);
      const content = "雲層暫時擋住了指令，請稍後再試一次。";
      if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => undefined);
      else await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
    });
  }
});

client.once("ready", async (readyClient) => {
  readyClient.user.setPresence({ status: "online", activities: [{ name: config.activity, type: ActivityType.Playing }] });
  console.log(`[Cyrene Cloud] Discord 已連線：${readyClient.user.tag}`);
  const commands = [
    new SlashCommandBuilder().setName("chat").setDescription("和雲端昔漣說話，可直接附圖")
      .addStringOption((option) => option.setName("message").setDescription("想說的話（附圖時可留空）").setRequired(false))
      .addAttachmentOption((option) => option.setName("image").setDescription("PNG、JPEG、WebP 或 GIF 圖片").setRequired(false)),
    new SlashCommandBuilder().setName("forget").setDescription("清除目前頻道的雲端短期對話"),
    new SlashCommandBuilder().setName("status").setDescription("查看雲端連線狀態"),
    new SlashCommandBuilder().setName("play").setDescription("在你的官方 Spotify 裝置搜尋並播放歌曲")
      .addStringOption((option) => option.setName("url").setDescription("歌曲名稱或 Spotify 單曲／專輯／歌單連結").setRequired(true)),
    new SlashCommandBuilder().setName("spotify").setDescription("在你的官方 Spotify 裝置播放歌單或作者歌曲")
      .addStringOption((option) => option.setName("artist").setDescription("作者名稱").setRequired(false))
      .addStringOption((option) => option.setName("playlist").setDescription("Spotify 播放清單網址").setRequired(false)),
    new SlashCommandBuilder().setName("favorites").setDescription("播放既有收藏歌單"),
    new SlashCommandBuilder().setName("like").setDescription("收藏目前歌曲或直接網址")
      .addStringOption((option) => option.setName("url").setDescription("可省略；單一歌曲或影片網址").setRequired(false)),
    new SlashCommandBuilder().setName("queue").setDescription("查看目前播放與佇列"),
    new SlashCommandBuilder().setName("pause").setDescription("暫停或繼續播放"),
    new SlashCommandBuilder().setName("next").setDescription("播放下一首"),
    new SlashCommandBuilder().setName("previous").setDescription("返回上一首"),
    new SlashCommandBuilder().setName("leave").setDescription("停止播放並離開語音頻道"),
    new SlashCommandBuilder().setName("volume").setDescription("調整雲端播放器音量")
      .addIntegerOption((option) => option.setName("percent").setDescription("0 到 150").setMinValue(0).setMaxValue(150).setRequired(true)),
  ].map((command) => command.toJSON());
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    const existing = await rest.get(Routes.applicationCommands(readyClient.user.id)) as Array<{ id: string; name: string; type: number }>;
    for (const command of commands) {
      const current = existing.find((item) => item.type === 1 && item.name === command.name);
      if (current) {
        await rest.patch(Routes.applicationCommand(readyClient.user.id, current.id), { body: command });
      } else {
        await rest.post(Routes.applicationCommands(readyClient.user.id), { body: command });
      }
    }
    console.log(`[Cyrene Cloud] 已同步 ${commands.length} 個 / 指令，並保留 Discord Activity Entry Point`);
  } catch (error) {
    console.warn("[Cyrene Cloud] / 指令註冊失敗，文字提及仍可使用", error);
  }
});

await Promise.all([memory.init(), favorites.init(), musicUsage.init()]);
const musicUsageTimer = setInterval(() => {
  if (music.snapshot().status !== "playing") return;
  void musicUsage.addMinute().then((remaining) => {
    if (remaining <= 0) {
      console.warn("[CloudMusic] 已達每月免費流量保護限制，自動停止播放");
      music.stop();
    }
  }).catch((error) => console.error("[CloudMusic] 無法記錄播放用量", error));
}, 60_000);
musicUsageTimer.unref();
const healthServer = startHealthServer(config.port, () => ({
  discord: client.isReady() ? "connected" : "connecting",
  voiceActive: music.snapshot().voiceActive,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
}));

async function shutdown(signal: string) {
  console.log(`[Cyrene Cloud] 收到 ${signal}，安全停止`);
  healthServer.close();
  clearInterval(musicUsageTimer);
  music.stop();
  client.destroy();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

console.log("[Cyrene Cloud] 正在連線 Discord…");
await client.login(config.discordToken);
