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
      name: `${profile.username ?? "Cyrene"}  ·  COMMAND GUIDE`,
      iconURL: profile.avatarUrl,
    })
    .setTitle("想聊天、聽歌，直接叫我就好 ✦")
    .setDescription([
      "所有 `/` 指令都可以直接使用，不需要標註 Bot。",
      "使用 `/play` 或 `/spotify` 可在你已連線的官方 Spotify 裝置播放。",
    ].join("\n"))
    .addFields(
      {
        name: "💬  Chat & Voice",
        value: "`/chat` 和 Cyrene 聊天\n`/join` 開始語音通話　`/leave` 結束通話並離開頻道",
        inline: false,
      },
      {
        name: "🎮  Play & Draw",
        value: "`/game` 直接在 Discord 內開啟《繩結同行》\n`/draw` 將繪圖委託交給 Codex（僅擁有者）",
        inline: false,
      },
      {
        name: "🎧  Music Playback",
        value: "`/play` 在官方 Spotify 裝置搜尋並播放\n`/spotify` 播放 Spotify 歌單或搜尋作者\n兩者皆使用你的 Premium 帳號，不會在 Discord 語音頻道代播",
        inline: false,
      },
      {
        name: "♡  Music Library",
        value: "`/like` 收藏目前歌曲或連結\n`/favorites` 播放收藏歌單　`/history` 查看播放紀錄",
        inline: false,
      },
      {
        name: "⚙  Playback Queue",
        value: "`/queue` 查看播放佇列　`/remove` 移出指定歌曲　`/clear` 清空後續佇列",
        inline: false,
      },
      {
        name: "✦  Quick start",
        value: "先開啟一台 Spotify 裝置 → 使用 `/play` 或 `/spotify` 開始播放。\n使用 `/status` 可確認 Bot 的連線、延遲與語音狀態。",
        inline: false,
      },
    )
    .setFooter({ text: "Only visible to you  ·  Cyrene Music & Companion" });
  if (profile.avatarUrl) embed.setThumbnail(profile.avatarUrl);
  const shortcuts = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}favorites`).setLabel("Favorites").setEmoji("💖").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}history`).setLabel("History").setEmoji("🕘").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}queue`).setLabel("Queue").setEmoji("📃").setStyle(ButtonStyle.Secondary),
  );
  return { content: "", embeds: [embed], components: [shortcuts] };
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
) {
  const selected = playlists.find(p => p.id === selectedPlaylistId);

  if (!selectedPlaylistId || !selected) {
    // 1. Show Playlists Menu
    const visible = playlists.slice(0, 25);
    const embed = new EmbedBuilder()
      .setColor(0xd95fa8)
      .setAuthor({ name: "Cyrene Music  ·  PLAYLISTS" })
      .setTitle("My Playlists")
      .setDescription(playlists.length
        ? playlists.map((p, index) => `\`${String(index + 1).padStart(2, "0")}\` 📂 **${p.name}** (${p.tracks.length} tracks)${p.url ? " · Spotify" : ""}`).join("\n")
        : "No playlists found. Click ➕ below to create one!"
      )
      .setFooter({ text: "Only visible to you  ·  Select a playlist to view tracks" });

    const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
    if (visible.length) {
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-select`)
          .setPlaceholder("📂 Select a playlist to view")
          .addOptions(visible.map((p) => ({
            label: p.name.slice(0, 100),
            description: `${p.tracks.length} tracks${p.url ? " (stream link)" : ""}`.slice(0, 100),
            value: p.id,
          }))),
      ));
    }

    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-add`).setLabel("➕ Add Playlist").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DISCORD_MUSIC_BUTTON_PREFIX}playlist-delete-menu`).setLabel("🗑️ Delete Playlist").setStyle(ButtonStyle.Danger).setDisabled(playlists.length <= 1),
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
      : "你的 Spotify 帳號目前沒有可讀取的播放清單。")
    .setFooter({ text: "只有你看得到  ·  選擇後 Cyrene 會自動加入語音頻道" });
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

const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("直接和 Cyrene 聊天，不需要標註她")
    .addStringOption((option) => option.setName("message").setDescription("想對她說的話").setRequired(true)),
  new SlashCommandBuilder()
    .setName("draw")
    .setDescription("由 Codex 生成圖片並透過 Discord 私訊回傳（僅擁有者）")
    .addStringOption((option) => option.setName("prompt").setDescription("可只輸入關鍵詞，例如：我想看你穿黑絲").setMaxLength(1800).setRequired(true)),
  new SlashCommandBuilder().setName("game").setDescription("由昔漣在 Discord 內開啟《繩結同行》"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("在你的官方 Spotify 裝置搜尋並播放歌曲")
    .addStringOption((option) => option.setName("url").setDescription("歌曲名稱或 Spotify 單曲／專輯／歌單連結").setRequired(true)),
  new SlashCommandBuilder().setName("nowplaying").setDescription("顯示並更新目前的音樂播放器"),
  new SlashCommandBuilder().setName("queue").setDescription("查看目前歌曲與接下來的播放佇列"),
  new SlashCommandBuilder().setName("history").setDescription("查看最近聽過的歌曲與影片"),
  new SlashCommandBuilder()
    .setName("like")
    .setDescription("收藏目前歌曲，或收藏一個 Bilibili／YouTube／Spotify 單曲連結")
    .addStringOption((option) => option.setName("url").setDescription("可省略；單一歌曲或影片連結").setRequired(false)),
  new SlashCommandBuilder().setName("favorites").setDescription("從第一首開始播放收藏歌單"),
  new SlashCommandBuilder()
    .setName("spotify")
    .setDescription("在你的官方 Spotify 裝置播放歌單或作者熱門歌曲")
    .addStringOption((option) => option.setName("artist").setDescription("可省略；輸入想聽的作者名稱").setRequired(false))
    .addStringOption((option) => option.setName("playlist").setDescription("可省略；直接輸入 Spotify 播放清單網址以播放歌曲").setRequired(false)),
  new SlashCommandBuilder().setName("clear").setDescription("清空接下來的歌曲，但保留目前歌曲"),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("從播放佇列移除指定歌曲")
    .addIntegerOption((option) => option.setName("position").setDescription("歌單中顯示的序號").setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName("join").setDescription("讓 Cyrene 加入你的語音頻道進行 AI 通話"),
  new SlashCommandBuilder().setName("leave").setDescription("讓 Cyrene 離開目前的語音頻道"),
  new SlashCommandBuilder().setName("status").setDescription("查看 Bot、延遲、伺服器與語音狀態"),
  new SlashCommandBuilder().setName("help").setDescription("顯示 Cyrene 的 Discord 功能與指令"),
];

export const DISCORD_SLASH_COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] = commands
  .map((command) => command.toJSON());

export const DISCORD_SLASH_COMMAND_NAMES = DISCORD_SLASH_COMMANDS.map((command) => command.name);
