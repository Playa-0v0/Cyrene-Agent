import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { formatMusicDuration, type DiscordMusicRequest, type DiscordMusicTrack } from "./music-source";
import type { DiscordMusicState } from "./voice-call";
import type { DiscordMusicHistoryEntry } from "./music-history";
import type { DiscordMusicFavoriteEntry, DiscordMusicPlaylist } from "./music-favorites";
import type { SpotifyArtistSummary, SpotifyPlaylistSummary } from "../../spotify-control";

export type DiscordSpotifyPlaylistChoice = SpotifyPlaylistSummary & { savedLink?: boolean };

export const DISCORD_MUSIC_BUTTON_PREFIX = "cyrene:music:";

export function buildDiscordHelp(profile: { username?: string; avatarUrl?: string } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xd95fa8)
    .setAuthor({
      name: `${profile.username ?? "Cyrene"} · 陪伴與功能指南 ✦`,
      iconURL: profile.avatarUrl,
    })
    .setTitle("🌸 昔漣功能與指令指南")
    .setDescription("隨時在頻道發送訊息或輸入指令即可與昔漣互動～✨")
    .addFields(
      {
        name: "💬  文字聊天與發送語音 (Chat & Voice Message)",
        value: "• `@昔漣` 或 `/chat` 展開心靈對話\n• 說 **「想聽你說...」** 或 **「發個語音」** ➔ 昔漣會回傳 **語音訊息 (TTS 音檔)** 🎙️\n• `/join` 邀請昔漣加入語音通話 | `/leave` 結束通話",
        inline: false,
      },
      {
        name: "⚔️  遊戲代肝與自動每日 (Game Daily Automation)",
        value: "• 說 **「幫我打 (遊戲名)」**（例如 **「幫我打鳴潮」** / **「幫我玩鳴潮」**）➔ 自動登入並完成每日代肝（擁有者專屬）",
        inline: false,
      },
      {
        name: "🎵  音樂代播與聲優導播 (Music & DJ)",
        value: "• `/play [歌名/網址]` 播歌 | `/list` 播放歌單 | `/dj` 昔漣聲優導播",
        inline: false,
      },
      {
        name: "🌙  生活陪伴與助眠儀式 (Living & Sleep)",
        value: "• `/sleep` 白噪音助眠 | `/checkin` 每日簽到領御守 | `/achievements` 成就 | `/whisper` 悄悄話",
        inline: false,
      },
      {
        name: "♟️  娛樂與遊戲對弈 (Games & Draw)",
        value: "• `/chess` 西洋棋對戰 | `/tarot` 幸運塔羅 | `/photo` 昔漣拍立得 | `/game` 繩結同行 | `/draw` 畫圖",
        inline: false,
      },
    )
    .setFooter({ text: "昔漣 Companion · 日常生活同在 🌸" });
  if (profile.avatarUrl) embed.setThumbnail(profile.avatarUrl);
  return { content: "", embeds: [embed] };
}

export function buildDiscordMusicControls(paused = false, resumeOnly = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}previous`).setEmoji("⏮️").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(resumeOnly),
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}toggle`).setEmoji(paused ? "▶️" : "⏸️").setLabel(paused ? "Play" : "Pause").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}skip`).setEmoji("⏭️").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(resumeOnly),
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorite`).setEmoji("❤️").setLabel("Like").setStyle(ButtonStyle.Success).setDisabled(resumeOnly),
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}stop`).setEmoji("👋").setLabel("Leave").setStyle(ButtonStyle.Danger).setDisabled(resumeOnly),
  );
}

export function buildDiscordMusicModes(
  shuffle = false,
  repeat: DiscordMusicState["repeat"] = "off",
  autoplay = false,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}shuffle-toggle`)
      .setEmoji("🔀")
      .setLabel("Shuffle")
      .setStyle(shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}repeat-cycle`)
      .setEmoji(repeat === "track" ? "🔂" : "🔁")
      .setLabel("Repeat")
      .setStyle(repeat !== "off" ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}autoplay-toggle`)
      .setEmoji("♾️")
      .setLabel("Auto")
      .setStyle(autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}source-link`)
      .setEmoji("📋")
      .setLabel("Copy")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites`)
      .setEmoji("💖")
      .setLabel("Playlists")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildDiscordMusicLibrary(currentVolume = 100): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}volume-down`)
      .setLabel("−")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}volume-display`)
      .setEmoji("🔊")
      .setLabel(`${Math.max(0, Math.min(150, Math.round(currentVolume)))}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}volume-up`)
      .setLabel("+")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}queue`)
      .setEmoji("📃")
      .setLabel("Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}history`)
      .setEmoji("🕘")
      .setLabel("History")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildDiscordVolumeControl(currentVolume = 100): ActionRowBuilder<StringSelectMenuBuilder> {
  const nearest = [0, 25, 50, 75, 100, 125, 150]
    .reduce((best, value) => Math.abs(value - currentVolume) < Math.abs(best - currentVolume) ? value : best, 100);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}volume`)
      .setPlaceholder("🔊 Select volume")
      .addOptions(
        { label: "Mute", description: "0%", value: "0", emoji: "🔇", default: nearest === 0 },
        { label: "Quiet", description: "25%", value: "25", emoji: "🔈", default: nearest === 25 },
        { label: "Soft", description: "50%", value: "50", emoji: "🔉", default: nearest === 50 },
        { label: "Medium", description: "75%", value: "75", emoji: "🔉", default: nearest === 75 },
        { label: "Normal", description: "100%", value: "100", emoji: "🔊", default: nearest === 100 },
        { label: "Loud", description: "125%", value: "125", emoji: "🔊", default: nearest === 125 },
        { label: "Maximum", description: "150%", value: "150", emoji: "🔊", default: nearest === 150 },
      ),
  );
}

function formatPlayerTime(seconds: number | undefined): string {
  const safe = Math.max(0, Math.floor(seconds ?? 0));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function buildDiscordMusicProgress(elapsed: number, duration?: number): string {
  const slots = 14;
  const safeDuration = Math.max(0, duration ?? 0);
  const ratio = safeDuration > 0 ? Math.max(0, Math.min(1, elapsed / safeDuration)) : 0;
  // Discord Embed 不支援原生動態進度元件，只能定期編輯訊息。
  // 未取得媒體長度時改用往返的活動指示，避免圓點永遠卡在最左邊。
  const streamStep = Math.floor(Math.max(0, elapsed) / 5);
  const streamPeriod = Math.max(1, (slots - 1) * 2);
  const streamPosition = streamStep % streamPeriod;
  const streamMarker = streamPosition < slots ? streamPosition : streamPeriod - streamPosition;
  const marker = safeDuration > 0
    ? Math.min(slots - 1, Math.floor(ratio * slots))
    : streamMarker;
  const rail = Array.from({ length: slots }, (_, index) => index === marker ? "●" : "─").join("");
  return `${formatPlayerTime(elapsed)} ${rail} ${safeDuration > 0 ? formatPlayerTime(safeDuration) : "串流中"}`;
}

/** Discord 原生播放器卡片；切歌與進度刷新時直接 edit 同一則消息。 */
export function buildDiscordMusicPlayer(state: DiscordMusicState) {
  const current = state.current;
  if (!state.active) {
    if (state.resumable && current) {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: "Cyrene Music  ·  READY TO RESUME" })
        .setTitle(current.title.slice(0, 256))
        .setDescription([
          current.playlistTitle ? `💿 **${current.playlistTitle}**` : "🎵 **單曲播放**",
          "",
          `⏸ \`${buildDiscordMusicProgress(state.elapsed, current.duration)}\``,
          "",
          "已離開語音頻道。先進入語音頻道，再按藍色 **Play** 就能從這裡繼續。",
        ].join("\n"))
        .setFooter({ text: `已保留播放進度  ·  QUEUE ${state.queue.length}` });
      if (current.thumbnail && /^https?:\/\//i.test(current.thumbnail)) embed.setThumbnail(current.thumbnail);
      return { content: "", embeds: [embed], components: [
        buildDiscordMusicControls(true, true),
        buildDiscordMusicLibrary(state.volume),
        buildDiscordMusicModes(state.shuffle, state.repeat, state.autoplay),
      ] };
    }
    return {
      content: "",
      embeds: [new EmbedBuilder()
        .setColor(0x7d728d)
        .setAuthor({ name: "Cyrene Music" })
        .setTitle("播放已結束")
        .setDescription("已離開語音頻道，活動文字已恢復。")],
      components: [],
    };
  }

  if (!current) {
    return {
      content: "",
      embeds: [new EmbedBuilder()
        .setColor(0xd95fa8)
        .setAuthor({ name: "Cyrene Music • 準備播放" })
        .setTitle("正在讀取音樂…")
        .setDescription("取得音訊後，這張卡片會自動更新。")],
      components: [buildDiscordMusicControls(state.paused), buildDiscordMusicLibrary(state.volume), buildDiscordMusicModes(state.shuffle, state.repeat, state.autoplay)],
    };
  }

  const embed = new EmbedBuilder()
    .setColor(0xd95fa8)
    .setAuthor({ name: state.paused ? "Cyrene Music  ·  PAUSED" : "Cyrene Music  ·  NOW PLAYING" })
    .setTitle(current.title.slice(0, 256))
    .setDescription([
      current.playlistTitle ? `💿 **${current.playlistTitle}**` : "🎵 **單曲播放**",
      "",
      `${state.paused ? "⏸" : "▶"} \`${buildDiscordMusicProgress(state.elapsed, current.duration)}\``,
    ].join("\n"))
    .addFields(
      { name: "UP NEXT", value: state.queue[0]?.title?.slice(0, 1024) || "佇列播放完畢", inline: true },
      { name: "MODE", value: [state.shuffle ? "Shuffle" : "Ordered", state.repeat === "track" ? "Repeat one" : state.repeat === "queue" ? "Repeat all" : null, state.autoplay ? "Auto play" : null].filter(Boolean).join(" · "), inline: true },
    )
    .setFooter({ text: `VOL ${state.volume}%  ·  TRACK ${current.index}/${current.total}  ·  QUEUE ${state.queue.length}` });

  if (current.thumbnail && /^https?:\/\//i.test(current.thumbnail)) embed.setThumbnail(current.thumbnail);

  return {
    content: "",
    embeds: [embed],
    components: [buildDiscordMusicControls(state.paused), buildDiscordMusicLibrary(state.volume), buildDiscordMusicModes(state.shuffle, state.repeat, state.autoplay)],
  };
}

export function buildDiscordMusicQueue(state: DiscordMusicState) {
  const current = state.current;
  const visible = state.queue.slice(0, 15);
  const lines = visible.map((track, index) => {
    const duration = track.duration ? ` · ${formatPlayerTime(track.duration)}` : "";
    return `\`${String(index + 1).padStart(2, "0")}\`  ${track.title.slice(0, 180)}${duration}`;
  });
  const remaining = state.queue.length - visible.length;
  const embed = new EmbedBuilder()
    .setColor(0x9d6be8)
    .setAuthor({ name: "Cyrene Music  ·  PRIVATE QUEUE" })
    .setTitle(current?.playlistTitle?.slice(0, 256) || "播放佇列")
    .setDescription([
      current ? `**正在播放**\n${current.title}` : "目前沒有正在播放的歌曲。",
      "",
      lines.length ? `**接下來**\n${lines.join("\n")}` : "接下來沒有歌曲。",
      remaining > 0 ? `\n另有 ${remaining} 首未顯示` : "",
    ].filter(Boolean).join("\n"))
    .setFooter({ text: `只有你看得到  ·  ${state.queue.length} 首等待播放` });
  if (current?.thumbnail && /^https?:\/\//i.test(current.thumbnail)) embed.setThumbnail(current.thumbnail);
  return { content: "", embeds: [embed], components: [] };
}

export function buildDiscordMusicSearchResults(
  query: string,
  tracks: DiscordMusicTrack[],
  sessionId: string,
) {
  const embed = new EmbedBuilder()
    .setColor(0xd95fa8)
    .setAuthor({ name: "Cyrene Music  ·  SEARCH" })
    .setTitle(`選擇要播放的音樂`)
    .setDescription([
      `搜尋：**${query.slice(0, 200)}**`,
      "",
      ...tracks.map((track, index) => `\`${index + 1}\`  ${track.title.slice(0, 180)}${track.duration ? ` · ${formatMusicDuration(track.duration)}` : ""}`),
    ].join("\n"))
    .setFooter({ text: "選擇後會自動加入你所在的語音頻道" });
  if (tracks[0]?.thumbnail && /^https?:\/\//i.test(tracks[0].thumbnail)) embed.setThumbnail(tracks[0].thumbnail);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}search:${sessionId}`)
    .setPlaceholder("🎵 Select a track")
    .addOptions(tracks.slice(0, 10).map((track, index) => ({
      label: track.title.slice(0, 100),
      description: `${index + 1}${track.duration ? ` · ${formatMusicDuration(track.duration)}` : ""}`.slice(0, 100),
      value: String(index),
    })));
  return { content: "", embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };
}

export function buildDiscordMusicHistory(entries: DiscordMusicHistoryEntry[]) {
  const visible = entries.slice(0, 15);
  const lines: string[] = [];
  for (const [index, entry] of visible.entries()) {
      const title = entry.title.replace(/[\[\]]/g, "").slice(0, 160);
      const timestamp = Math.floor(Date.parse(entry.playedAt) / 1000);
      const time = Number.isFinite(timestamp) ? ` · <t:${timestamp}:R>` : "";
      const playlist = entry.playlistTitle ? `\n　　${entry.playlistTitle.slice(0, 100)}` : "";
      const safeUrl = /^https?:\/\//i.test(entry.url) ? entry.url.slice(0, 1024) : "";
      const linkedTitle = safeUrl ? `[${title}](${safeUrl})` : title;
      const copyableUrl = safeUrl ? `\n　　🔗 \`${safeUrl.replace(/`/g, "%60")}\`` : "";
      const line = `\`${String(index + 1).padStart(2, "0")}\` ${linkedTitle}${time}${playlist}${copyableUrl}`;
      // Discord embed description 上限為 4096；保留餘量，避免 API 拒絕整則互動回覆。
      if ([...lines, line].join("\n").length > 3900) break;
      lines.push(line);
  }
  const description = lines.length
    ? lines.join("\n")
    : "還沒有播放紀錄。使用 `/play` 播放歌曲後會自動保存在這裡。";
  const embed = new EmbedBuilder()
    .setColor(0x9d6be8)
    .setAuthor({ name: "Cyrene Music  ·  PRIVATE HISTORY" })
    .setTitle("最近聽過的歌曲與影片")
    .setDescription(description)
    .setFooter({ text: `只有你看得到  ·  顯示最近 ${lines.length} 筆` });
  if (visible[0]?.thumbnail && /^https?:\/\//i.test(visible[0].thumbnail)) embed.setThumbnail(visible[0].thumbnail);
  return { content: "", embeds: [embed], components: [] };
}

export function buildDiscordMusicPlaylists(
  playlists: DiscordMusicPlaylist[],
  selectedPlaylistId?: string,
  _legacyAccountPlaylists: DiscordSpotifyPlaylistChoice[] = [],
) {
  const selected = playlists.find(p => p.id === selectedPlaylistId);

  if (!selectedPlaylistId || !selected) {
    // 1. Show Playlists Menu
    const visibleLocal = playlists.filter((playlist) => playlist.folder !== "spotify").slice(0, 25);
    const visibleSpotify = playlists.filter((playlist) => playlist.folder === "spotify").slice(0, 25 - visibleLocal.length);
    const lines: string[] = [];

    // Bili/YT local playlists
    for (const [index, p] of visibleLocal.entries()) {
      const trackCount = p.url ? (p.total ?? 0) : p.tracks.length;
      const titleDisplay = p.url ? `[${p.name}](${p.url})` : p.name;
      lines.push(`\`${String(index + 1).padStart(2, "0")}\` 📂 **${titleDisplay}** (${trackCount} tracks)${p.url ? " · Spotify" : ""}`);
    }

    // Cyrene-owned Spotify link folder. This never reads or mutates the user's
    // Spotify account playlist library.
    if (visibleSpotify.length) {
      lines.push("");
      lines.push("**📁 Spotify Playlist**");
      for (const [i, p] of visibleSpotify.entries()) {
        const num = visibleLocal.length + i + 1;
        lines.push(`\`${String(num).padStart(2, "0")}\` 🟢 **[${p.name}](${p.url ?? ""})**${p.total ? ` (${p.total} tracks)` : ""}`);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0xd95fa8)
      .setAuthor({ name: "Cyrene Music  ·  PLAYLISTS" })
      .setTitle("My Playlists")
      .setDescription(lines.length ? lines.join("\n") : "No playlists found. Click ➕ below to create one!")
      .setFooter({ text: "Only visible to you  ·  Spotify folder stores links, not account data" });

    const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
    if (visibleLocal.length || visibleSpotify.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-select`)
          .setPlaceholder("📂 Select a playlist to view or play")
          .addOptions([
            ...visibleLocal.map((p) => {
              const trackCount = p.url ? (p.total ?? 0) : p.tracks.length;
              return {
                label: `📂 ${p.name}`.slice(0, 100),
                description: `${trackCount} tracks${p.url ? " (stream link)" : ""}`.slice(0, 100),
                value: p.id,
              };
            }),
            ...visibleSpotify.map((p) => ({
              label: `🟢 ${p.name}`.slice(0, 100),
              description: `${p.total ? `${p.total} tracks · ` : ""}Saved Spotify link`.slice(0, 100),
              value: `spotify:${p.id}`,
            }))
          ]),
      ));
    }

    const canDelete = playlists.some((playlist) => playlist.id !== "default");
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-add`).setLabel("➕ Add Playlist").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-edit`).setLabel("✏️ Edit Playlist").setStyle(ButtonStyle.Secondary).setDisabled(!playlists.length),
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-delete-menu`).setLabel("🗑️ Delete Playlist").setStyle(ButtonStyle.Danger).setDisabled(!canDelete),
    ));

    return { content: "", embeds: [embed], components };
  } else {
    // 2. Show tracks in the selected playlist
    const tracks = selected.tracks;
    const visible = tracks.slice(0, 25);
    const lines: string[] = [];
    for (const [index, entry] of visible.entries()) {
      const source = /open\.spotify\.com/i.test(entry.url) ? "🟢"
        : /(?:bilibili\.com|b23\.tv)/i.test(entry.url) ? "📺"
        : /(?:youtube\.com|youtu\.be)/i.test(entry.url) ? "▶️"
        : "🎵";
      const title = entry.title.replace(/[\[\]]/g, "").slice(0, 150);
      const safeUrl = /^https?:\/\//i.test(entry.url) ? entry.url.slice(0, 1024) : "";
      const linkedTitle = safeUrl ? `[${title}](${safeUrl})` : title;
      const line = `\`${String(index + 1).padStart(2, "0")}\` ${source} ${linkedTitle}`;
      if ([...lines, line].join("\n").length > 3900) break;
      lines.push(line);
    }

    const embed = new EmbedBuilder()
      .setColor(0xd95fa8)
      .setAuthor({ name: `Cyrene Music  ·  📂 ${selected.name}` })
      .setTitle(`Playlist Tracks (${tracks.length} tracks)`)
      .setDescription(lines.length ? lines.join("\n") : "This playlist is currently empty. Use /like or click Add Track below to add music.")
      .setFooter({ text: `Only visible to you  ·  Showing top ${lines.length} tracks` });
    if (visible[0]?.thumbnail && /^https?:\/\//i.test(visible[0].thumbnail)) embed.setThumbnail(visible[0].thumbnail);

    const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
    if (visible.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-select`)
          .setPlaceholder("🎵 Select a track to play")
          .addOptions(visible.map((entry, index) => ({
            label: entry.title.slice(0, 100),
            description: `${index + 1}${entry.playlistTitle ? ` · ${entry.playlistTitle}` : ""}`.slice(0, 100),
            value: entry.id,
          }))),
      ));
    }

    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-back`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-play-all`).setLabel("▶️ Play Playlist").setStyle(ButtonStyle.Primary).setDisabled(!tracks.length),
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-add`).setLabel("➕ Add Track").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites-delete`).setLabel("🗑️ Delete Track").setStyle(ButtonStyle.Danger).setDisabled(!visible.length),
    ));

    return { content: "", embeds: [embed], components };
  }
}

export function buildDiscordSpotifyPlaylists(playlists: DiscordSpotifyPlaylistChoice[]) {
  const visible = playlists.slice(0, 25);
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setAuthor({ name: "Cyrene Music  ·  SPOTIFY" })
    .setTitle("選擇 Spotify 播放清單")
    .setDescription(visible.length
      ? visible.map((playlist, index) => `\`${String(index + 1).padStart(2, "0")}\` **${playlist.name.slice(0, 150)}** · ${playlist.savedLink ? "已儲存連結" : `${playlist.total} 首`}`).join("\n")
      : "Spotify Playlist 資料夾目前是空的。播放 Spotify 歌單後按 ❤️ Like，或在 Playlists 使用 Add Playlist 儲存連結。")
    .setFooter({ text: "只有你看得到  ·  這裡只讀取 Cyrene 保存的 playlist 連結" });
  if (visible[0]?.imageUrl && /^https?:\/\//i.test(visible[0].imageUrl)) embed.setThumbnail(visible[0].imageUrl);
  const components = visible.length
    ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}spotify-select`)
        .setPlaceholder("🎧 選擇 Spotify Playlist")
        .addOptions(visible.map((playlist) => ({
          label: playlist.name.slice(0, 100),
          description: `${playlist.savedLink ? "已儲存的 playlist 連結" : `${playlist.total} 首${playlist.owner ? ` · ${playlist.owner}` : ""}`}`.slice(0, 100),
          value: playlist.id,
        }))),
    )]
    : [];
  return { content: "", embeds: [embed], components };
}

export function buildDiscordSpotifyArtists(query: string, artists: SpotifyArtistSummary[]) {
  const visible = artists.slice(0, 10);
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setAuthor({ name: "Cyrene Music  ·  SPOTIFY ARTISTS" })
    .setTitle("選擇想聽的作者")
    .setDescription(visible.length
      ? [`搜尋：**${query.slice(0, 150)}**`, "", ...visible.map((artist, index) => {
        const followers = typeof artist.followers === "number" ? ` · ${artist.followers.toLocaleString("zh-TW")} 位追蹤者` : "";
        return `\`${String(index + 1).padStart(2, "0")}\` **${artist.name.slice(0, 150)}**${followers}`;
      })].join("\n")
      : `找不到符合「${query.slice(0, 150)}」的 Spotify 作者。`)
    .setFooter({ text: "只有你看得到  ·  選擇後播放作者熱門歌曲" });
  if (visible[0]?.imageUrl && /^https?:\/\//i.test(visible[0].imageUrl)) embed.setThumbnail(visible[0].imageUrl);
  const components = visible.length
    ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}spotify-artist-select`)
        .setPlaceholder("🎤 選擇 Spotify 作者")
        .addOptions(visible.map((artist) => ({
          label: artist.name.slice(0, 100),
          description: typeof artist.followers === "number" ? `${artist.followers.toLocaleString("zh-TW")} 位追蹤者` : "播放熱門歌曲",
          value: artist.id,
        }))),
    )]
    : [];
  return { content: "", embeds: [embed], components };
}

export function musicRequestFromButton(
  customId: string,
  paused = false,
  shuffle = false,
  repeat: DiscordMusicState["repeat"] = "off",
  autoplay = false,
  volume = 100,
): DiscordMusicRequest | null {
  if (!customId.startsWith(DISCORD_MUSIC_BUTTON_PREFIX)) return null;
  const action = customId.slice(DISCORD_MUSIC_BUTTON_PREFIX.length);
  if (action === "toggle") return { command: paused ? "resume" : "pause" };
  if (action === "shuffle-toggle") return { command: shuffle ? "ordered" : "shuffle" };
  if (action === "repeat-cycle") {
    return { command: repeat === "off" ? "repeat-queue" : repeat === "queue" ? "repeat-track" : "repeat-off" };
  }
  if (action === "refresh") return { command: "refresh" };
  if (action === "autoplay-toggle") return { command: autoplay ? "autoplay-off" : "autoplay-on" };
  if (action === "history") return { command: "history" };
  if (action === "favorite") return { command: "favorite" };
  if (action === "favorites") return { command: "favorites" };
  if (action === "volume-down") return { command: "volume", value: Math.max(0, volume - 25) };
  if (action === "volume-up") return { command: "volume", value: Math.min(150, volume + 25) };
  if (["previous", "skip", "queue", "stop"].includes(action)) {
    return { command: action as "previous" | "skip" | "queue" | "stop" };
  }
  return null;
}

export function isDiscordCheckinGreetingText(text: string): boolean {
  const cleaned = text.replace(/<@!?\d+>/g, "").trim();
  return /^(?:簽到|每日簽到|打卡|簽個到|早安|晚安|午安|早上好|下午好|中午好|晚上好|安安|早呀|晚安呀|早安安|晚安安|睡前問候)$/ui.test(cleaned);
}

export function buildDiscordCheckinEmbed(userName: string, streakDays: number, totalCheckins: number, greetingText?: string) {
  const titleText = greetingText ? `${greetingText}，${userName}～✨` : `簽到成功！早安，${userName}～✨`;
  const charms = [
    "🌸【平安御守】「願夥伴今天事事順心，心情如春花般燦爛♪」",
    "✨【幸運御守】「今天會有意想不到的小美好降臨在夥伴身上喔～」",
    "💖【甜夢御守】「今晚能睡個無憂無慮的好覺，昔漣會守護著你～」",
    "🌿【舒心御守】「累了就隨時停下來，有昔漣一直陪著你呢。」",
  ];
  const charm = charms[Math.floor(Math.random() * charms.length)];
  const embed = new EmbedBuilder()
    .setColor(0xff94c2)
    .setAuthor({ name: "昔漣 · 每日簽到儀式 🌸" })
    .setTitle(titleText)
    .setDescription([
      `祝夥伴今天也是充滿活力與好心情的一天！`,
      "",
      `🎴 **昔漣今日御守**`,
      charm,
    ].join("\n"))
    .addFields(
      { name: "🔥 連續簽到", value: `${streakDays} 天`, inline: true },
      { name: "✨ 累計簽到", value: `${totalCheckins} 次`, inline: true },
    )
    .setFooter({ text: "昔漣陪伴手記 · 日常生活同在" });
  return { embeds: [embed] };
}

export function buildDiscordAchievementsEmbed(userName: string, stats: { daysTogether: number; messagesCount: number; musicTracksPlayed: number; unlockedBadges: string[] }) {
  const embed = new EmbedBuilder()
    .setColor(0xd95fa8)
    .setAuthor({ name: "昔漣 · 夥伴相處成就展覽館 🏆" })
    .setTitle(`${userName} 與 昔漣 的陪伴點滴`)
    .setDescription([
      `「每一天有夥伴在身邊，都是值得珍藏的美好時光～♪」`,
      "",
      `📅 **相伴時光**：第 **${stats.daysTogether}** 天`,
      `💬 **對話點滴**：累計交流 **${stats.messagesCount}** 次`,
      `🎵 **音樂時光**：共度播放 **${stats.musicTracksPlayed}** 首歌曲`,
      "",
      `🏅 **已解鎖成就**`,
      stats.unlockedBadges.map((badge) => `• ${badge}`).join("\n"),
    ].join("\n"))
    .setFooter({ text: "永遠陪伴在夥伴身邊 🌸" });
  return { embeds: [embed] };
}

export function buildDiscordTarotEmbed(userName: string) {
  const cards = [
    { title: "🌟 星辰 (The Star)", desc: "光明、希望與靈感之牌。今天適合勇敢嘗試新事物，幸運隨之而來！" },
    { title: "☀️ 太陽 (The Sun)", desc: "活力、成功與溫暖之牌。今天充滿正能量，任何煩惱都會煙消雲散～" },
    { title: "💖 戀人 (The Lovers)", desc: "和諧、選擇與美好的連結。今天身邊充滿溫暖的善意與貼心陪伴。" },
    { title: "🌿 節制 (Temperance)", desc: "平靜、平衡與內在充實。保持輕鬆放鬆的節奏，一切都會剛剛好。" },
  ];
  const card = cards[Math.floor(Math.random() * cards.length)];
  const embed = new EmbedBuilder()
    .setColor(0x9d6be8)
    .setAuthor({ name: "昔漣 · 每日靈感塔羅 🔮" })
    .setTitle(`為 ${userName} 抽出的幸運塔羅牌`)
    .setDescription([
      `🃏 **${card.title}**`,
      "",
      card.desc,
      "",
      "「無論牌面如何，昔漣都會一直陪伴在夥伴身邊為你加持喔～✨」",
    ].join("\n"))
    .setFooter({ text: "昔漣塔羅靈感 · 祝你有美好的一天" });
  return { embeds: [embed] };
}

export function buildDiscordChessEmbed(userName: string, moveHistory = "1. e4 e5") {
  const boardEmoji = [
    "```",
    "8 ♜ ♞ ♝ ♛ ♚ ♝ ♞ ♜",
    "7 ♟ ♟ ♟ ♟ . ♟ ♟ ♟",
    "6 . . . . . . . .",
    "5 . . . . ♟ . . .",
    "4 . . . . ♙ . . .",
    "3 . . . . . . . .",
    "2 ♙ ♙ ♙ ♙ . ♙ ♙ ♙",
    "1 ♖ ♘ ♗ ♕ ♔ ♗ ♘ ♖",
    "  a b c d e f g h",
    "```",
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x4b7bec)
    .setAuthor({ name: "昔漣 · 西洋棋對弈對戰 ♟️" })
    .setTitle(`${userName} 🆚 昔漣`)
    .setDescription([
      `「昔漣已經應戰囉！看招～✨」`,
      "",
      `**當前棋盤狀態**`,
      boardEmoji,
      "",
      `📜 **走棋歷史**：\`${moveHistory}\``,
      `👉 **輪到你了**：請在頻道輸入你的下一步（如 \`e4\`、\`Nf3\` 或 \`d4\`），昔漣會為你對弈思考並回應喔！`,
    ].join("\n"))
    .setFooter({ text: "昔漣棋藝靈感 · 智力與陪伴同在 ♟️" });
  return { embeds: [embed] };
}

const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("直接和 Cyrene 聊天，不需要標註她，可直接附圖")
    .addStringOption((option) => option.setName("message").setDescription("想對她說的話").setRequired(false))
    .addAttachmentOption((option) => option.setName("image").setDescription("PNG、JPEG、WebP 或 GIF 圖片").setRequired(false)),
  new SlashCommandBuilder()
    .setName("ww")
    .setDescription("使用 WutheringWavesUID 查詢鳴潮資料")
    .addStringOption((option) => option.setName("command").setDescription("例如：幫助、登入、今汐面板").setRequired(false))
    .addAttachmentOption((option) => option.setName("file").setDescription("匯入抽卡資料或提供辨識圖片").setRequired(false)),
  new SlashCommandBuilder()
    .setName("draw")
    .setDescription("由 Codex 生成圖片並透過 Discord 私訊回傳（僅擁有者）")
    .addStringOption((option) => option.setName("prompt").setDescription("可只輸入關鍵詞，例如：我想看你穿黑絲").setMaxLength(1800).setRequired(true)),
  new SlashCommandBuilder().setName("game").setDescription("由昔漣在 Discord 內開啟《繩結同行》"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("搜尋歌曲，或播放 YouTube／Bilibili／SoundCloud／Spotify 連結")
    .addStringOption((option) => option.setName("url").setDescription("可省略，預設播放 Spotify 的 anime 歌單；或輸入歌曲名稱、音樂網址/播放清單").setRequired(false)),
  new SlashCommandBuilder()
    .setName("list")
    .setDescription("播放收藏清單（YT/Bili）或 Spotify 歌單")
    .addStringOption((option) =>
      option.setName("name")
        .setDescription("搜尋你的 YT/Bili 收藏歌曲或 Spotify 歌單名稱（留空顯示全部）")
        .setAutocomplete(true)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("讓 Cyrene 加入你的語音頻道進行 AI 通話")
    .addBooleanOption((option) =>
      option.setName("muted").setDescription("設置為 true 可讓昔漣閉麥安靜陪伴（預設 false 開麥通話）").setRequired(false)
    ),
  new SlashCommandBuilder().setName("leave").setDescription("讓 Cyrene 離開目前的語音頻道"),
  new SlashCommandBuilder().setName("status").setDescription("查看 Bot、延遲、伺服器與語音狀態"),
  new SlashCommandBuilder().setName("help").setDescription("顯示 Cyrene 的 Discord 功能與指令"),
  new SlashCommandBuilder().setName("emojis").setDescription("查看昔漣使用不同表情符號的統計次數"),
  new SlashCommandBuilder().setName("forget").setDescription("清除目前頻道的雲端短期對話"),
  new SlashCommandBuilder().setName("checkin").setDescription("昔漣每日簽到儀式與領取昔漣御守小卡"),
  new SlashCommandBuilder().setName("sleep").setDescription("開啟昔漣白噪音安眠模式（雨聲／海浪／篝火）"),
  new SlashCommandBuilder().setName("dj").setDescription("開啟或關閉點歌昔漣語音 DJ 導播模式"),
  new SlashCommandBuilder().setName("photo").setDescription("生成一張昔漣當下陪伴拍立得手繪快照"),
  new SlashCommandBuilder().setName("achievements").setDescription("查看夥伴與昔漣的相伴天數與解鎖成就"),
  new SlashCommandBuilder().setName("tarot").setDescription("抽一張昔漣每日幸運塔羅靈感卡"),
  new SlashCommandBuilder().setName("chess").setDescription("與昔漣開始一局西洋棋對弈對戰"),
  new SlashCommandBuilder().setName("guesssong").setDescription("開啟聽歌猜曲名小遊戲"),
  new SlashCommandBuilder().setName("asmr").setDescription("讓昔漣為你進行睡前極致耳語 ASMR 陪伴"),
  new SlashCommandBuilder().setName("sing").setDescription("讓昔漣為你甜美哼唱動聽的歌曲旋律"),
  new SlashCommandBuilder()
    .setName("whisper")
    .setDescription("將你對昔漣的悄悄話收進共享筆記本珍藏")
    .addStringOption((option) => option.setName("content").setDescription("想告訴昔漣的悄悄話心事").setRequired(true)),
];

export const DISCORD_SLASH_COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commands
  .map((command) => command.toJSON());

export const DISCORD_SLASH_COMMAND_NAMES = DISCORD_SLASH_COMMANDS.map((command) => command.name);
