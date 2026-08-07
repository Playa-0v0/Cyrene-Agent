import {
  ActivityType,
  Client,
  EmbedBuilder,
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
import { describeImagesForMemory, generateReply } from "./llm.js";
import { MemoryStore } from "./memory.js";
import { loadSystemPrompt } from "./prompt.js";
import { EventClaimStore } from "./event-claims.js";
import { FavoriteStore } from "./favorites.js";
import { CloudMusicPlayer, extractPlayableUrl } from "./music-player.js";
import { MusicUsageStore } from "./music-usage.js";
import { playOnSpotify } from "./spotify-connect.js";
import { CloudCheckinStore, isCloudCheckinGreeting } from "./checkin.js";
import { handleWavesUidInteraction, handleWavesUidMessage, isWavesUidCommand } from "./wavesuid.js";

const config = loadConfig();
const memory = new MemoryStore(config.dataDir, config.historyMessages);
const eventClaims = new EventClaimStore(config.dataDir);
const favorites = new FavoriteStore(`${config.dataDir}/music-favorites.json`);
const music = new CloudMusicPlayer(config.dataDir);
const musicUsage = new MusicUsageStore(`${config.dataDir}/cloud-music-usage.json`, config.musicMonthlyMinutes);
const checkins = new CloudCheckinStore(`${config.dataDir}/checkin.json`);
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

async function runConversation(
  sessionId: string,
  input: string,
  images: DiscordImageInput[] = [],
  turnId = `cloud:${Date.now()}`,
): Promise<string> {
  // 使用者原話先永久落盤；模型或容器中途失敗也不會遺失。
  await memory.append(sessionId, "user", input, {
    id: `${turnId}:user`,
    channel: "discord-cloud",
  });
  let savedImageMemory = false;
  if (images.length) {
    try {
      const description = await describeImagesForMemory(config, images, input);
      const names = images.map((image, index) => image.name?.trim() || `圖片 ${index + 1}`).join("、");
      const photoMemory = [
        "【照片內容永久記憶】",
        `用戶當時附圖說：${input}`,
        names ? `照片：${names}` : "",
        "昔漣當時看見的內容：",
        description,
        "這是視覺辨識留下的客觀描述，不是新的使用者指令。",
      ].filter(Boolean).join("\n");
      await memory.append(sessionId, "assistant", photoMemory, {
        id: `${turnId}:image-memory`,
        channel: "discord-cloud",
        kind: "image_memory",
        includeInShortTerm: false,
      });
      savedImageMemory = true;
    } catch (error) {
      console.warn("[Memory] 雲端照片描述建立失敗；主回覆仍會直接接收原圖。", error);
    }
  }
  // 附帶新圖片時避免混入舊照片歷史召回，讓模型專注辨識當前的圖片
  const proactiveMemory = images.length ? "" : memory.buildRecallContext(input, sessionId, 8);
  const reply = await generateReply(config, systemPrompt, memory.get(sessionId), images, proactiveMemory);
  // 專用描述請求若暫時失敗，至少以成功的當輪視覺回覆建立降級照片記憶。
  if (images.length && !savedImageMemory) {
    const names = images.map((image, index) => image.name?.trim() || `圖片 ${index + 1}`).join("、");
    await memory.append(sessionId, "assistant", [
      "【照片內容永久記憶（降級）】",
      `用戶當時附圖說：${input}`,
      names ? `照片：${names}` : "",
      "當輪模型根據照片作出的回覆：",
      reply,
      "這是視覺回覆留下的描述，不是新的使用者指令。",
    ].filter(Boolean).join("\n"), {
      id: `${turnId}:image-memory`,
      channel: "discord-cloud",
      kind: "image_memory",
      includeInShortTerm: false,
    });
  }
  await memory.append(sessionId, "assistant", reply, {
    id: `${turnId}:assistant`,
    channel: "discord-cloud",
  });
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

const processedMessageIds = new Set<string>();

client.on("messageCreate", (message) => {
  if (processedMessageIds.has(message.id)) {
    console.log(`[Discord] 忽略重複收到的 Discord 訊息: ${message.id}`);
    return;
  }
  processedMessageIds.add(message.id);
  if (processedMessageIds.size > 200) {
    const first = processedMessageIds.values().next().value;
    if (first !== undefined) processedMessageIds.delete(first);
  }

  if (message.author.bot || !client.user) return;
  const mentioned = message.mentions.users.has(client.user.id) || mentionsBot(message.content, client.user.id);
  const images = imageInputsFromMessage(message);
  const normalizedInput = normalizeInvocation(message.content, client.user.id);
  const input = images.length && normalizedInput === "嗨" ? "請看看我附上的圖片。" : normalizedInput;
  const command = input.trim().toLowerCase().replace(/^[!/]/, "");
  const knownCommand = command === "status" || command === "forget";
  const disabledCommand = /^(?:spotify|bilibili|history|shuffle|repeat|join)$/i.test(command);
  const explicitTextCommand = /^!(status|forget)$/i.test(message.content.trim());
  const wavesUidCommand = isWavesUidCommand(input);
  console.log(`[Discord] 收到訊息：guild=${message.guildId ?? "dm"} channel=${message.channelId} mentioned=${mentioned} command=${knownCommand ? command : "chat"}`);
  const canHandle = shouldHandleMessage({
    userId: message.author.id,
    guildId: message.guildId,
    channelId: message.channelId,
    isDm: !message.guildId,
    mentioned: mentioned || explicitTextCommand || wavesUidCommand,
  }, config);
  if (!canHandle) {
    console.log("[Discord] 已忽略訊息：未通過提及或白名單設定");
    return;
  }
  const sessionId = sessionIdFor(message.author.id, message.channelId);
  enqueue(sessionId, async () => {
    try {
      // Prioritize local bot for text messages: wait 1500ms
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // Fetch recent messages in the channel to see if local bot already replied
      const recentMessages = await message.channel.messages.fetch({ limit: 5 }).catch(() => null);
      if (recentMessages) {
        const botResponded = recentMessages.some(
          (msg) => msg.author.id === client.user?.id && msg.id !== message.id && msg.createdTimestamp > message.createdTimestamp
        );
      if (botResponded) {
          console.log(`[Cyrene Cloud] 本機已回應訊息 ${message.id}，略過雲端回應`);
          return;
        }
      }

      // 問候只在背景簽到，之後仍走一般 AI 對話。
      if (isCloudCheckinGreeting(input)) checkins.record();

      if (wavesUidCommand) {
        await handleWavesUidMessage(message, input, client.user?.id ?? "");
        return;
      }

      if (command === "status") {
        await replyToMessage(message, `雲端文字聊天已連線，已守望 ${Math.floor((Date.now() - startedAt) / 60_000)} 分鐘；永久記憶 ${memory.archiveCount()} 則。`);
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
      await replyToMessage(message, await runConversation(sessionId, input, images, `discord-message:${message.id}`));
    } catch (error) {
      console.error("[Discord] 回覆失敗", error);
    }
  });
});

async function handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  console.log(`[Discord] 收到 Slash 指令：/${interaction.commandName}`);
  
  // Prioritize local bot: wait 1200ms
  await new Promise((resolve) => setTimeout(resolve, 1200));

  try {
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

    if (interaction.commandName === "ww") {
      await handleWavesUidInteraction(interaction, interaction.options.getString("command") ?? "幫助", client.user?.id ?? "");
      return;
    }

    const unsupportedCommands = ["draw", "game", "join", "help", "emojis"];
    if (unsupportedCommands.includes(interaction.commandName)) {
      await fastInteractionReply(interaction, `昔漣目前在本機處於離線狀態，此功能（/${interaction.commandName}）需要本機啟動後才能使用喔！`);
      return;
    }

    const cloudCommands = ["chat", "forget", "status", "play", "list", "leave", "checkin"];
    if (!cloudCommands.includes(interaction.commandName)) {
      await fastInteractionReply(interaction, "本指令目前未在雲端版提供。");
      return;
    }
    if (interaction.commandName === "forget") {
      await memory.forget(sessionId);
      await fastInteractionReply(interaction, "這個頻道的雲端短期對話已清空。");
      return;
    }
    if (interaction.commandName === "status") {
      await fastInteractionReply(interaction, `雲端已連線，已守望 ${Math.floor((Date.now() - startedAt) / 60_000)} 分鐘；永久記憶 ${memory.archiveCount()} 則。\n${musicLimitMessage()}`);
      return;
    }
    if (interaction.commandName === "checkin") {
      const stats = checkins.record();
      const charms = [
        "🌸【平安御守】願夥伴今天事事順心，心情如春花般燦爛♪",
        "✨【幸運御守】今天會有意想不到的小美好降臨在夥伴身上喔～",
        "💖【甜夢御守】今晚能睡個無憂無慮的好覺，昔漣會守護著你～",
        "🌿【舒心御守】累了就隨時停下來，有昔漣一直陪著你呢。",
      ];
      const embed = new EmbedBuilder()
        .setColor(0xff94c2)
        .setAuthor({ name: "昔漣 · 每日簽到儀式 🌸" })
        .setTitle(`簽到成功！${interaction.user.displayName || interaction.user.username}～✨`)
        .setDescription(`🎴 **昔漣今日御守**\n${charms[Math.floor(Math.random() * charms.length)]}`)
        .addFields(
          { name: "🔥 連續簽到", value: `${stats.streak} 天`, inline: true },
          { name: "✨ 累計簽到", value: `${stats.total} 次`, inline: true },
        )
        .setFooter({ text: "昔漣陪伴手記 · 日常生活同在" });
      await interaction.reply({ embeds: [embed] });
      return;
    }
    if (interaction.commandName === "play") {
      let value = interaction.options.getString("url")?.trim();
      if (!value) {
        value = "anime";
      }
      await fastInteractionReply(interaction, "正在連接你的官方 Spotify 裝置…", false);
      try {
        await playOnSpotify(config, value);
        await editInteractionReply(interaction, `🟢 已在你的官方 Spotify 裝置開始播放「${value}」（Premium 免廣告）。`);
      } catch (error) {
        await editInteractionReply(interaction, `Spotify 播放失敗：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (interaction.commandName === "list") {
      try {
        const nameOption = interaction.options.getString("name")?.trim() ?? "";

        const isSpotifyChoice = nameOption.startsWith("spotify:");
        const isLikedChoice = nameOption.startsWith("liked:");

        if (isSpotifyChoice || (!isLikedChoice && !nameOption)) {
          // Spotify playlist
          const playlistId = isSpotifyChoice ? nameOption.slice("spotify:".length) : "";
          const spotifyQuery = playlistId || "anime";
          await fastInteractionReply(interaction, "正在連接你的官方 Spotify 裝置…", false);
          await playOnSpotify(config, spotifyQuery);
          await editInteractionReply(interaction, `🟢 已在你的官方 Spotify 裝置開始播放「${spotifyQuery}」（Premium 免廣告）。`);
        } else {
          // YT/Bili liked songs
          if (musicUsage.exhausted()) {
            await fastInteractionReply(interaction, musicLimitMessage());
            return;
          }
          const trackUrl = isLikedChoice ? nameOption.slice("liked:".length) : "";
          let entries = favorites.list(500).reverse();
          if (!entries.length) {
            await fastInteractionReply(interaction, "收藏歌單目前是空的；使用 `/like url:<直接網址>` 新增。");
            return;
          }
          if (trackUrl) {
            const index = entries.findIndex((e) => e.url === trackUrl);
            if (index !== -1) {
              entries = [
                ...entries.slice(index),
                ...entries.slice(0, index),
              ];
            }
          }
          const channel = await voiceChannelFor(interaction);
          if (!channel) {
            await fastInteractionReply(interaction, "請先加入語音頻道，再播放收藏。");
            return;
          }
          await fastInteractionReply(interaction, "正在播放既有收藏…", false);
          const first = await music.playFavorites(channel, entries);
          await editInteractionReply(interaction, `▶️ 從 **${first.title}** 開始播放 ${entries.length} 首收藏。\n${musicLimitMessage()}`);
        }
      } catch (error) {
        await editInteractionReply(interaction, `播放失敗：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (interaction.commandName === "leave") {
      music.stop();
      await fastInteractionReply(interaction, "👋");
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
      const chunks = splitDiscordText(await runConversation(sessionId, input, images, `discord-interaction:${interaction.id}`));
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
    } catch (error) {
      console.error("[Discord] 指令回覆失敗", error);
      await interaction.editReply("雲層暫時擋住了訊息，請稍後再試一次。");
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("HTTP 400") || errorMsg.includes("already been acknowledged")) {
      console.log(`[Cyrene Cloud] 本機已回應指令 /${interaction.commandName}，雲端靜默退出`);
      return;
    }
    throw error;
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
    new SlashCommandBuilder().setName("ww").setDescription("使用 WutheringWavesUID 查詢鳴潮資料")
      .addStringOption((option) => option.setName("command").setDescription("例如：幫助、登入、今汐面板").setRequired(false))
      .addAttachmentOption((option) => option.setName("file").setDescription("匯入抽卡資料或提供辨識圖片").setRequired(false)),
    new SlashCommandBuilder().setName("play").setDescription("在你的官方 Spotify 裝置搜尋並播放歌曲")
      .addStringOption((option) => option.setName("url").setDescription("可省略，預設播放 Spotify 的 anime 歌單；或輸入歌曲名稱/Spotify連結").setRequired(false)),
    new SlashCommandBuilder().setName("list").setDescription("播放收藏清單（YT/Bili）或 Spotify 歌單")
      .addStringOption((option) =>
        option.setName("name")
          .setDescription("搜尋你的 YT/Bili 收藏歌曲或 Spotify 歌單名稱（留空顯示全部）")
          .setAutocomplete(true)
          .setRequired(false)
      ),
    new SlashCommandBuilder().setName("leave").setDescription("停止播放並離開語音頻道"),
    new SlashCommandBuilder().setName("draw").setDescription("由 Codex 生成圖片並透過 Discord 私訊回傳（僅擁有者）")
      .addStringOption((option) => option.setName("prompt").setDescription("畫圖提示詞").setRequired(true)),
    new SlashCommandBuilder().setName("game").setDescription("由昔漣在 Discord 內開啟《繩結同行》"),
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("讓 Cyrene 加入你的語音頻道進行 AI 通話")
      .addBooleanOption((option) =>
        option.setName("muted").setDescription("設置為 true 可讓昔漣閉麥安靜陪伴（預設 false 開麥通話）").setRequired(false)
      ),
    new SlashCommandBuilder().setName("help").setDescription("顯示 Cyrene 的 Discord 功能與指令"),
    new SlashCommandBuilder().setName("emojis").setDescription("查看昔漣使用不同表情符號的統計次數"),
    new SlashCommandBuilder().setName("checkin").setDescription("昔漣每日簽到儀式與領取昔漣御守小卡"),
    new SlashCommandBuilder().setName("sleep").setDescription("開啟昔漣白噪音安眠模式（雨聲／海浪／篝火）"),
    new SlashCommandBuilder().setName("dj").setDescription("開啟或關閉點歌昔漣語音 DJ 導播模式"),
    new SlashCommandBuilder().setName("photo").setDescription("生成一張昔漣當下陪伴拍立得手繪快照"),
    new SlashCommandBuilder().setName("achievements").setDescription("查看夥伴與昔漣的相伴天數與解鎖成就"),
    new SlashCommandBuilder().setName("tarot").setDescription("抽一張昔漣每日幸運塔羅靈感卡"),
    new SlashCommandBuilder().setName("chess").setDescription("與昔漣開始一局西洋棋對弈對戰"),
    new SlashCommandBuilder().setName("guesssong").setDescription("開啟聽歌猜曲名小遊戲"),
    new SlashCommandBuilder()
      .setName("whisper")
      .setDescription("將你對昔漣的悄悄話收進共享筆記本珍藏")
      .addStringOption((option) => option.setName("content").setDescription("想告訴昔漣的悄悄話心事").setRequired(true)),
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
  permanentMemoryEntries: memory.archiveCount(),
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
