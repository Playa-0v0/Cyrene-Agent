import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { ActivityType, PermissionFlagsBits, type Client, type Message } from "discord.js";
import prism from "prism-media";
import type { DiscordChannelConfig } from "../../settings-store";
import type { IncomingMessage, OutgoingMessage } from "../../types";
import {
  formatMusicDuration,
  resolveDiscordMusicTracks,
  searchDiscordMusicTracks,
  spawnDiscordMusicStream,
  type DiscordMusicRequest,
  type DiscordMusicProcess,
  type DiscordMusicTrack,
} from "./music-source";
import { recordDiscordMusicInNotebook } from "./notebook-activity";
import { recordDiscordMusicHistory } from "./music-history";
import { toTraditionalTaiwan } from "../../../utils/opencc";
import { startCallUsage, stopCallUsage } from "../../../call-usage-store";

const LOG = "[DiscordVoice]";
const MAX_UTTERANCE_BYTES = 48_000 * 2 * 2 * 30;

/**
 * Human hearing is logarithmic, so a linear 25/50/75 gain sounds too similar.
 * Square the 0–100 range for clearer perceived steps, while keeping the
 * existing conservative boost above 100% to avoid excessive clipping.
 */
export function discordMusicVolumeGain(percent: number): number {
  const normalized = Math.max(0, Math.min(150, percent)) / 100;
  return normalized <= 1 ? normalized * normalized : normalized;
}

export interface DiscordVoiceServices {
  transcribe: (pcm16Mono16k: Buffer) => Promise<string>;
  synthesize: (text: string) => Promise<{ audio: Buffer; format: "wav" | "mp3" } | null>;
}

let services: DiscordVoiceServices | null = null;

export function setDiscordVoiceServices(next: DiscordVoiceServices): void {
  services = next;
}

export function getDiscordVoiceServices(): DiscordVoiceServices | null {
  return services;
}

export type DiscordVoiceCommand = "join" | "leave" | null;

export interface DiscordMusicState {
  active: boolean;
  paused: boolean;
  current: DiscordMusicTrack | null;
  queue: DiscordMusicTrack[];
  volume: number;
  repeat: "off" | "track" | "queue";
  shuffle: boolean;
  autoplay: boolean;
  elapsed: number;
}

export interface DiscordMusicControlResult {
  ok: boolean;
  message: string;
}

export function parseDiscordVoiceCommand(text: string): DiscordVoiceCommand {
  const normalized = text.trim().replace(/[！!。.，,？?]/g, "");
  if (/^(加入|進入|進來|來)(語音|通話|聊天|dc通話)$/.test(normalized)
    || /^(加入語音頻道|進來陪我通話|陪我通話)$/.test(normalized)) return "join";
  if (/^(離開|退出|結束|停止)(語音|通話|聊天|dc通話)$/.test(normalized)
    || /^(掛斷|離開語音頻道|結束通話)$/.test(normalized)) return "leave";
  return null;
}

/** Discord 解碼後為 48kHz/16-bit/stereo；Whisper/阿里雲使用 16kHz/mono。 */
export function stereo48kToMono16k(input: Buffer): Buffer {
  const frames = Math.floor(input.length / 4);
  const outputFrames = Math.floor(frames / 3);
  const output = Buffer.allocUnsafe(outputFrames * 2);
  let out = 0;
  for (let frame = 0; frame + 2 < frames; frame += 3) {
    const offset = frame * 4;
    const left = input.readInt16LE(offset);
    const right = input.readInt16LE(offset + 2);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((left + right) / 2))), out);
    out += 2;
  }
  return output.subarray(0, out);
}

export function formatDiscordMusicActivity(title: string, playlistTitle?: string): string {
  const traditionalTitle = toTraditionalTaiwan(title);
  const traditionalPlaylistTitle = playlistTitle ? toTraditionalTaiwan(playlistTitle) : undefined;
  const cleaned = traditionalTitle.replace(/^.*?\sp\d{1,3}\s+/i, "").trim() || traditionalTitle.trim() || "音樂";
  const tagged = cleaned.match(/^【([^】]+)】\s*(.+)$/);
  const song = tagged?.[2]?.trim() || cleaned;
  const category = tagged?.[1]?.trim();
  const collection = traditionalPlaylistTitle
    ?.replace(/\s*(?:(?:歌曲)?全收[录錄]|音[乐樂]集)\s*$/i, "")
    .trim();
  const activity = [`🎧 ${song}`, category, collection].filter(Boolean).join("｜");
  return [...toTraditionalTaiwan(activity)].slice(0, 128).join("");
}

export class DiscordVoiceCall {
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private mode: "call" | "music" | null = null;
  private guildId: string | null = null;
  private textChannelId: string | null = null;
  private activeUserId: string | null = null;
  private activeUserName: string | undefined;
  private processing = false;
  private speaking = false;
  private capturing = new Set<string>();
  private musicQueue: Array<DiscordMusicTrack & { queueOrder: number }> = [];
  private musicHistory: Array<DiscordMusicTrack & { queueOrder: number }> = [];
  private musicOwnerId: string | null = null;
  private currentMusicTrack: (DiscordMusicTrack & { queueOrder: number }) | null = null;
  private musicProcess: DiscordMusicProcess | null = null;
  private prefetchedMusic: {
    queueOrder: number;
    process: DiscordMusicProcess;
    stderr: string;
    failed: boolean;
    onData: (chunk: Buffer) => void;
    onError: () => void;
    onClose: (code: number | null) => void;
  } | null = null;
  private prefetchingMusicOrder: number | null = null;
  private musicResource: AudioResource<DiscordMusicTrack> | null = null;
  private musicRepeat: "off" | "track" | "queue" = "off";
  private musicShuffle = false;
  private musicAutoplay = false;
  private musicVolume = 100;
  private musicOrder = 0;
  private advancingMusic = false;
  private skipMusicRepeat = false;

  constructor(
    private readonly client: Client,
    private readonly getConfig: () => DiscordChannelConfig,
    private readonly dispatch: (msg: IncomingMessage) => Promise<OutgoingMessage | null>,
    private readonly onMusicStateChange?: (state: DiscordMusicState) => void | Promise<void>,
  ) {}

  private notifyMusicStateChange(): void {
    if (!this.onMusicStateChange) return;
    const state = this.getMusicState();
    queueMicrotask(() => void this.onMusicStateChange?.(state));
  }

  isActive(): boolean {
    return this.connection !== null && this.guildId !== null;
  }

  canControlMusic(userId: string): boolean {
    return !this.musicOwnerId || this.musicOwnerId === userId;
  }

  getMusicState(): DiscordMusicState {
    const current = this.currentMusicTrack
      ? (({ queueOrder: _queueOrder, ...track }) => track)(this.currentMusicTrack)
      : null;
    return {
      active: this.mode === "music" && !!this.connection && !!this.player,
      paused: this.player?.state.status === AudioPlayerStatus.Paused
        || this.player?.state.status === AudioPlayerStatus.AutoPaused,
      current,
      queue: this.musicQueue.map(({ queueOrder: _queueOrder, ...track }) => ({ ...track })),
      volume: this.musicVolume,
      repeat: this.musicRepeat,
      shuffle: this.musicShuffle,
      autoplay: this.musicAutoplay,
      elapsed: Math.max(0, Math.round((this.musicResource?.playbackDuration ?? 0) / 1000)),
    };
  }

  async controlMusic(command: NonNullable<DiscordMusicRequest["command"]>, value?: number): Promise<DiscordMusicControlResult> {
    const player = this.player;
    if (this.mode !== "music" || !this.connection || !player) {
      return { ok: false, message: "目前沒有正在播放的 Discord 音樂。" };
    }
    if (command === "previous") {
      const previous = this.musicHistory.pop();
      if (!previous) return { ok: false, message: "目前沒有上一首歌曲。" };
      this.musicQueue = this.musicQueue.filter((track) => track.queueOrder !== previous.queueOrder);
      if (this.currentMusicTrack) this.musicQueue.unshift(this.currentMusicTrack);
      this.musicQueue.unshift(previous);
      this.stopPrefetchedMusic();
      this.currentMusicTrack = null;
      this.stopPlayerAndAdvance(true);
      return { ok: true, message: "已回到上一首。" };
    }
    if (command === "pause") {
      const changed = player.pause(true);
      if (changed) this.notifyMusicStateChange();
      return { ok: changed, message: changed ? "已暫停播放。" : "目前沒有正在播放的音樂。" };
    }
    if (command === "resume") {
      const changed = player.unpause();
      if (changed) this.notifyMusicStateChange();
      return { ok: changed, message: changed ? "已繼續播放。" : "目前沒有暫停中的音樂。" };
    }
    if (command === "skip") {
      if (!this.currentMusicTrack) return { ok: false, message: "目前沒有正在播放的音樂。" };
      this.stopPlayerAndAdvance(true);
      return { ok: true, message: "已切換到下一首。" };
    }
    if (command === "stop") {
      await this.leave();
      return { ok: true, message: "已停止播放並離開語音頻道。" };
    }
    if (command === "repeat-track" || command === "repeat-queue" || command === "repeat-off") {
      this.musicRepeat = command === "repeat-track" ? "track" : command === "repeat-queue" ? "queue" : "off";
      this.notifyMusicStateChange();
      return { ok: true, message: this.musicRepeat === "track" ? "已開啟單曲循環。" : this.musicRepeat === "queue" ? "已開啟播放清單循環。" : "已關閉循環。" };
    }
    if (command === "shuffle") {
      this.musicShuffle = true;
      this.shuffleTracks(this.musicQueue);
      this.scheduleNextMusicPrefetch();
      this.notifyMusicStateChange();
      return { ok: true, message: "已切換為隨機播放。" };
    }
    if (command === "autoplay-on" || command === "autoplay-off") {
      this.musicAutoplay = command === "autoplay-on";
      this.notifyMusicStateChange();
      return { ok: true, message: this.musicAutoplay ? "已開啟自動推薦。" : "已關閉自動推薦。" };
    }
    if (command === "ordered") {
      this.musicShuffle = false;
      this.musicQueue.sort((a, b) => a.queueOrder - b.queueOrder);
      this.scheduleNextMusicPrefetch();
      this.notifyMusicStateChange();
      return { ok: true, message: "已切換為原本順序。" };
    }
    if (command === "clear") {
      const count = this.musicQueue.length;
      this.musicQueue = [];
      this.stopPrefetchedMusic();
      this.notifyMusicStateChange();
      return { ok: true, message: count ? `已清空接下來的 ${count} 首歌曲。` : "播放佇列本來就是空的。" };
    }
    if (command === "remove") {
      const index = Math.floor(value ?? 0);
      if (index < 1 || index > this.musicQueue.length) {
        return { ok: false, message: `請選擇 1–${Math.max(1, this.musicQueue.length)} 之間的歌曲序號。` };
      }
      const [removed] = this.musicQueue.splice(index - 1, 1);
      this.scheduleNextMusicPrefetch();
      this.notifyMusicStateChange();
      return { ok: true, message: `已從播放清單移除「${removed.title}」。` };
    }
    if (command === "volume") {
      const volume = Math.max(0, Math.min(150, Math.round(value ?? 100)));
      this.musicVolume = volume;
      this.musicResource?.volume?.setVolume(discordMusicVolumeGain(volume));
      this.notifyMusicStateChange();
      return { ok: true, message: `音量已調整為 ${volume}%。` };
    }
    if (command === "refresh") {
      this.notifyMusicStateChange();
      return { ok: true, message: "播放器已更新。" };
    }
    if (command === "queue") return { ok: true, message: this.getSessionSummary() };
    return { ok: false, message: "不支援這個播放控制。" };
  }

  async handleMusicRequest(message: Message, request: DiscordMusicRequest): Promise<boolean> {
    if (this.mode === "music" && request.command !== "queue" && !this.canControlMusic(message.author.id)) {
      await message.reply("這個播放工作階段由其他人控制；你不能修改她的音樂。");
      return true;
    }
    if (request.command) {
      if (this.mode !== "music" || !this.connection || !this.player) return false;
      return await this.handleMusicCommand(message, request);
    }
    if (!request.url) return false;
    if (this.getConfig().voiceEnabled === false) {
      await message.reply("Discord 語音目前未啟用，請先到 Cyrene 的 Discord 設定開啟。");
      return true;
    }
    const channel = message.member?.voice.channel;
    if (!channel) {
      await message.reply("你要先加入語音頻道，再把 YouTube 或 Bilibili 連結傳給我。");
      return true;
    }
    const botMember = channel.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!channel.joinable || !permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
      await message.reply("我沒有加入或播放音樂的權限，請替 Bot 開啟「連接」與「說話」。");
      return true;
    }

    const progress = await message.reply("🔎 正在讀取連結與播放清單…");
    try {
      const tracks = await resolveDiscordMusicTracks(request.url);
      if (!tracks.length) {
        await progress.edit("沒有找到可以播放的音訊。");
        return true;
      }
      if (this.mode !== "music" || this.guildId !== channel.guild.id || !this.connection || !this.player) {
        await this.connectForMusic(message);
      }
      const queued = tracks.map((track) => ({ ...track, queueOrder: this.musicOrder++ }));
      if (this.musicShuffle) this.shuffleTracks(queued);
      this.musicQueue.push(...queued);
      if (this.currentMusicTrack) this.scheduleNextMusicPrefetch();
      this.notifyMusicStateChange();
      const first = tracks[0];
      const label = tracks.length > 1
        ? `${first.playlistTitle ? `**${first.playlistTitle}**\n` : ""}已加入 ${tracks.length} 首，從「${first.title}」開始自動續播。`
        : `已加入「${first.title}」。`;
      await progress.edit(`🎶 ${label}`);
      if (!this.currentMusicTrack && this.player?.state.status === AudioPlayerStatus.Idle) {
        void this.advanceMusic(false);
      }
    } catch (err) {
      console.error(LOG, "讀取音樂連結失敗:", err);
      await progress.edit(`無法讀取這個連結：${this.musicErrorMessage(err)}`).catch(() => undefined);
    }
    return true;
  }

  async handleResolvedMusicTracks(message: Message, tracks: DiscordMusicTrack[]): Promise<boolean> {
    if (this.mode === "music" && !this.canControlMusic(message.author.id)) {
      await message.reply("這個播放工作階段由其他人控制；你不能修改她的音樂。");
      return true;
    }
    if (!tracks.length) return false;
    if (this.getConfig().voiceEnabled === false) {
      await message.reply("Discord 語音目前未啟用，請先到 Cyrene 的 Discord 設定開啟。");
      return true;
    }
    const channel = message.member?.voice.channel;
    if (!channel) {
      await message.reply("你要先加入語音頻道，再選擇 Spotify 播放清單。");
      return true;
    }
    const botMember = channel.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!channel.joinable || !permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
      await message.reply("我沒有加入或播放音樂的權限，請替 Bot 開啟「連接」與「說話」。");
      return true;
    }
    const progress = await message.reply(`🔎 正在加入 Spotify 播放清單「${tracks[0].playlistTitle ?? "Spotify"}」…`);
    try {
      if (this.mode !== "music" || this.guildId !== channel.guild.id || !this.connection || !this.player) {
        await this.connectForMusic(message);
      }
      const queued = tracks.map((track) => ({ ...track, queueOrder: this.musicOrder++ }));
      if (this.musicShuffle) this.shuffleTracks(queued);
      this.musicQueue.push(...queued);
      if (this.currentMusicTrack) this.scheduleNextMusicPrefetch();
      this.notifyMusicStateChange();
      await progress.edit(`🎶 **${tracks[0].playlistTitle ?? "Spotify"}**\n已加入 ${tracks.length} 首，從「${tracks[0].title}」開始播放。`);
      if (!this.currentMusicTrack && this.player?.state.status === AudioPlayerStatus.Idle) {
        void this.advanceMusic(false);
      }
    } catch (error) {
      console.error(LOG, "加入 Spotify 播放清單失敗:", error);
      await progress.edit(`無法播放 Spotify 清單：${this.musicErrorMessage(error)}`).catch(() => undefined);
    }
    return true;
  }

  async handleCommand(message: Message, command: DiscordVoiceCommand): Promise<boolean> {
    if (!command) return false;
    if (command === "leave") {
      if (this.mode === "music" && !this.canControlMusic(message.author.id)) {
        await message.reply("這個播放工作階段由其他人控制；你不能讓 Bot 離開。");
        return true;
      }
      await this.leave();
      await message.reply("好，我先離開語音頻道了。");
      return true;
    }
    if (this.getConfig().voiceEnabled === false) {
      await message.reply("Discord 語音通話目前未啟用，請先到 Cyrene 的 Discord 設定開啟。");
      return true;
    }
    if (!getDiscordVoiceServices()) {
      await message.reply("語音服務尚未就緒，請重新啟動 Cyrene 後再試一次。");
      return true;
    }
    const channel = message.member?.voice.channel;
    if (!channel) {
      await message.reply("你要先加入一個語音頻道，我才能進去陪你通話。");
      return true;
    }
    const botMember = channel.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!channel.joinable || !permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
      await message.reply("我沒有加入或說話權限，請替 Bot 開啟「連接」與「說話」。");
      return true;
    }

    await this.leave();
    this.mode = "call";
    this.guildId = channel.guild.id;
    this.textChannelId = message.channelId;
    this.activeUserId = message.author.id;
    this.activeUserName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this.connection.subscribe(this.player);
    this.bindConnection();
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      console.error(LOG, "加入語音失敗:", err);
      await this.leave();
      await message.reply("我沒能連上語音頻道，請檢查 Bot 的連接／說話權限後再試。");
      return true;
    }
    startCallUsage("discord");
    await message.reply("我進來了。你直接說話就好，我會在你停下來後回答。要結束時標註我說「離開通話」。");
    return true;
  }

  async leave(): Promise<void> {
    const wasConnected = this.connection !== null;
    this.mode = null;
    this.processing = false;
    this.speaking = false;
    this.capturing.clear();
    this.musicQueue = [];
    this.musicHistory = [];
    this.musicOwnerId = null;
    this.currentMusicTrack = null;
    this.musicResource = null;
    this.musicRepeat = "off";
    this.musicShuffle = false;
    this.musicAutoplay = false;
    this.advancingMusic = false;
    this.skipMusicRepeat = false;
    this.stopMusicProcess();
    this.stopPrefetchedMusic();
    this.player?.stop(true);
    this.connection?.destroy();
    this.player = null;
    this.connection = null;
    this.guildId = null;
    this.textChannelId = null;
    this.activeUserId = null;
    this.activeUserName = undefined;
    this.restoreConfiguredPresence();
    this.notifyMusicStateChange();
    if (wasConnected) stopCallUsage("discord");
  }

  private bindConnection(): void {
    const connection = this.connection;
    const player = this.player;
    if (!connection || !player) return;
    connection.on("error", (err) => console.error(LOG, "voice connection error:", err));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await this.leave();
      }
    });
    player.on("error", (err) => {
      this.speaking = false;
      console.error(LOG, "audio player error:", err);
      if (this.mode === "music") {
        void this.sendMusicStatus(`播放失敗，將跳到下一首：${err.message}`);
        this.stopPlayerAndAdvance(true);
      }
    });
    player.on(AudioPlayerStatus.Idle, () => {
      this.speaking = false;
      if (this.mode === "music") {
        const skipRepeat = this.skipMusicRepeat;
        this.skipMusicRepeat = false;
        void this.advanceMusic(skipRepeat);
      }
    });
    connection.receiver.speaking.on("start", (userId) => {
      if (this.mode !== "call" || userId !== this.activeUserId || this.processing || this.speaking || this.capturing.has(userId)) return;
      this.captureUtterance(userId);
    });
  }

  private async connectForMusic(message: Message): Promise<void> {
    const channel = message.member?.voice.channel;
    if (!channel) throw new Error("你已經離開語音頻道");
    await this.leave();
    this.mode = "music";
    this.musicOwnerId = message.author.id;
    this.guildId = channel.guild.id;
    this.textChannelId = message.channelId;
    this.activeUserName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection.subscribe(this.player);
    this.bindConnection();
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      await this.leave();
      throw err;
    }
    // 使用者把 Bot 留在 Discord 語音頻道陪伴或播歌，都算作相處通話時間。
    startCallUsage("discord");
  }

  private async handleMusicCommand(
    message: Message,
    request: DiscordMusicRequest,
  ): Promise<boolean> {
    const command = request.command;
    if (!command) return false;
    if (command === "queue") {
      const playlist = this.currentMusicTrack?.playlistTitle ?? this.musicQueue[0]?.playlistTitle;
      const current = this.currentMusicTrack
        ? `正在播放：${this.currentMusicTrack.title}${this.trackDurationLabel(this.currentMusicTrack)}`
        : "目前沒有正在播放的歌曲";
      const visibleQueue = playlist
        ? this.musicQueue.filter((track) => track.playlistTitle === playlist)
        : this.musicQueue;
      const upcoming = visibleQueue.slice(0, 10)
        .map((track, index) => `${index + 1}. ${track.title}${this.trackDurationLabel(track)}`);
      const more = visibleQueue.length > 10 ? `\n…另外還有 ${visibleQueue.length - 10} 首` : "";
      await message.reply(`${playlist ? `播放清單：${playlist}\n` : ""}${current}\n${upcoming.length ? `接下來：\n${upcoming.join("\n")}${more}` : "佇列中沒有下一首。"}`);
      return true;
    }
    const result = await this.controlMusic(command, request.value);
    await message.reply(result.message);
    return true;
  }

  private async advanceMusic(skipRepeat: boolean): Promise<void> {
    if (this.advancingMusic || this.mode !== "music") return;
    this.advancingMusic = true;
    try {
      const finished = this.currentMusicTrack;
      this.currentMusicTrack = null;
      this.musicResource = null;
      this.stopMusicProcess();
      if (finished && !skipRepeat) {
        if (this.musicRepeat === "track") this.musicQueue.unshift(finished);
        else if (this.musicRepeat === "queue") this.musicQueue.push(finished);
      }
      if (finished && (skipRepeat || this.musicRepeat !== "track")) {
        this.musicHistory.push(finished);
        if (this.musicHistory.length > 50) this.musicHistory.shift();
      }

      let next = this.musicQueue.shift();
      if (!next && finished && this.musicAutoplay) {
        const seen = new Set([finished.url, ...this.musicHistory.map((track) => track.url)]);
        const recommendations = await searchDiscordMusicTracks(`${finished.title} music`, 5).catch(() => []);
        const recommendation = recommendations.find((track) => !seen.has(track.url));
        if (recommendation) next = { ...recommendation, queueOrder: this.musicOrder++ };
      }
      if (!next || !this.player || !this.connection) {
        await this.leave();
        return;
      }
      this.currentMusicTrack = next;
      const prepared = this.takePrefetchedMusic(next);
      const process = prepared?.process ?? await spawnDiscordMusicStream(next);
      this.musicProcess = process;
      let stderr = prepared?.stderr ?? "";
      process.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1200);
      });
      process.once("error", (err) => {
        if (this.musicProcess !== process || this.mode !== "music") return;
        console.error(LOG, "啟動 yt-dlp 失敗:", err);
        void this.sendMusicStatus(`無法播放「${next.title}」，將跳到下一首：${this.musicErrorMessage(err)}`);
        this.stopPlayerAndAdvance(true);
      });
      process.once("close", (code) => {
        if (code === 0 || this.musicProcess !== process || this.mode !== "music") return;
        console.error(LOG, `yt-dlp 結束 (code=${code}):`, stderr);
        void this.sendMusicStatus(`無法播放「${next.title}」，將跳到下一首：${this.musicErrorMessage(stderr)}`);
        this.stopPlayerAndAdvance(true);
      });
      this.speaking = true;
      const resource = createAudioResource(process.stdout, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
        metadata: next,
      });
      resource.volume?.setVolume(discordMusicVolumeGain(this.musicVolume));
      this.musicResource = resource;
      this.player.play(resource);
      this.scheduleNextMusicPrefetch();
      this.setMusicPresence(next);
      this.notifyMusicStateChange();
      void recordDiscordMusicInNotebook({
        title: next.title,
        url: next.url,
        playlistTitle: next.playlistTitle,
        companionName: this.activeUserName,
      });
      void recordDiscordMusicHistory(next);
    } catch (err) {
      console.error(LOG, "開始播放失敗:", err);
      this.currentMusicTrack = null;
      this.musicResource = null;
      this.stopMusicProcess();
      void this.sendMusicStatus(`播放失敗，將跳到下一首：${this.musicErrorMessage(err)}`);
      this.stopPlayerAndAdvance(true);
    } finally {
      this.advancingMusic = false;
    }
  }

  private stopMusicProcess(): void {
    const process = this.musicProcess;
    this.musicProcess = null;
    if (process?.exitCode === null && !process.killed) process.kill("SIGKILL");
  }

  /**
   * Keep exactly one upcoming yt-dlp process warm. Its stdout remains paused, so
   * extraction and the first small audio buffer are ready without downloading
   * the whole playlist or consuming unbounded memory.
   */
  private scheduleNextMusicPrefetch(): void {
    const next = this.musicQueue[0];
    if (this.mode !== "music" || !next) {
      this.stopPrefetchedMusic();
      return;
    }
    if (this.prefetchedMusic?.queueOrder === next.queueOrder || this.prefetchingMusicOrder === next.queueOrder) return;
    this.stopPrefetchedMusic();
    this.prefetchingMusicOrder = next.queueOrder;
    void spawnDiscordMusicStream(next).then((process) => {
      if (this.mode !== "music" || this.musicQueue[0]?.queueOrder !== next.queueOrder) {
        if (process.exitCode === null && !process.killed) process.kill("SIGKILL");
        return;
      }
      const state = {
        queueOrder: next.queueOrder,
        process,
        stderr: "",
        failed: false,
        onData: (_chunk: Buffer) => undefined,
        onError: () => undefined,
        onClose: (_code: number | null) => undefined,
      };
      state.onData = (chunk: Buffer) => { state.stderr = `${state.stderr}${chunk.toString("utf8")}`.slice(-1200); };
      state.onError = () => { state.failed = true; };
      state.onClose = (code: number | null) => { if (code !== 0) state.failed = true; };
      process.stderr.on("data", state.onData);
      process.once("error", state.onError);
      process.once("close", state.onClose);
      this.prefetchedMusic = state;
    }).catch((err) => {
      console.warn(LOG, `預取下一首失敗（播放時會重試）: ${this.musicErrorMessage(err)}`);
    }).finally(() => {
      if (this.prefetchingMusicOrder === next.queueOrder) this.prefetchingMusicOrder = null;
    });
  }

  private takePrefetchedMusic(track: DiscordMusicTrack & { queueOrder: number }): { process: DiscordMusicProcess; stderr: string } | null {
    const state = this.prefetchedMusic;
    this.prefetchedMusic = null;
    if (!state || state.queueOrder !== track.queueOrder || state.failed || state.process.killed) {
      if (state?.process.exitCode === null && !state.process.killed) state.process.kill("SIGKILL");
      return null;
    }
    state.process.stderr.off("data", state.onData);
    state.process.off("error", state.onError);
    state.process.off("close", state.onClose);
    return { process: state.process, stderr: state.stderr };
  }

  private stopPrefetchedMusic(): void {
    const state = this.prefetchedMusic;
    this.prefetchedMusic = null;
    this.prefetchingMusicOrder = null;
    if (!state) return;
    state.process.stderr.off("data", state.onData);
    state.process.off("error", state.onError);
    state.process.off("close", state.onClose);
    if (state.process.exitCode === null && !state.process.killed) state.process.kill("SIGKILL");
  }

  /**
   * AudioPlayer 在 Idle／Buffering 初期呼叫 stop() 可能回傳 false，且不會再發出 Idle。
   * 這時直接排程 advance，避免壞掉的單曲讓整份播放清單永久卡住。
   */
  private stopPlayerAndAdvance(skipRepeat: boolean): void {
    if (skipRepeat) this.skipMusicRepeat = true;
    const stopped = this.player?.stop(true) ?? false;
    if (stopped || this.mode !== "music") return;
    const skip = this.skipMusicRepeat;
    this.skipMusicRepeat = false;
    queueMicrotask(() => void this.advanceMusic(skip));
  }

  private shuffleTracks<T>(tracks: T[]): void {
    for (let index = tracks.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [tracks[index], tracks[swap]] = [tracks[swap], tracks[index]];
    }
  }

  private trackDurationLabel(track: DiscordMusicTrack): string {
    const duration = formatMusicDuration(track.duration);
    return duration ? ` · ${duration}` : "";
  }

  private musicErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const line = raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1) ?? "未知錯誤";
    if (/sign in|cookies|bot/i.test(raw)) return "YouTube 要求登入驗證，請稍後再試或改用另一個連結。";
    if (/private|permission|login/i.test(raw)) return "內容需要登入或沒有觀看權限。";
    return line.slice(0, 350);
  }

  private async sendMusicStatus(content: string): Promise<void> {
    const channelId = this.textChannelId;
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable()) await channel.send(content).catch(() => undefined);
  }

  private setMusicPresence(track: DiscordMusicTrack): void {
    const config = this.getConfig();
    this.client.user?.setPresence({
      status: config.presenceStatus ?? "online",
      activities: [{ name: formatDiscordMusicActivity(track.title, track.playlistTitle), type: ActivityType.Listening }],
    });
  }

  private restoreConfiguredPresence(): void {
    const config = this.getConfig();
    const activityText = config.activityText?.trim();
    this.client.user?.setPresence({
      status: config.presenceStatus ?? "online",
      activities: activityText ? [{ name: activityText, type: ActivityType.Playing }] : [],
    });
  }

  getSessionSummary(): string {
    if (this.mode === "call") return "AI 語音通話中";
    if (this.mode === "music") {
      const title = this.currentMusicTrack?.title ?? "準備播放";
      return `音樂播放中：${title}（佇列 ${this.musicQueue.length} 首，音量 ${this.musicVolume}%）`;
    }
    return "未加入語音頻道";
  }

  private captureUtterance(userId: string): void {
    const connection = this.connection;
    if (!connection) return;
    this.capturing.add(userId);
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let size = 0;
    opus.pipe(decoder);
    decoder.on("data", (chunk: Buffer) => {
      if (size >= MAX_UTTERANCE_BYTES) return;
      const remaining = MAX_UTTERANCE_BYTES - size;
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(Buffer.from(piece));
      size += piece.length;
    });
    decoder.on("error", (err) => console.error(LOG, "Opus 解碼失敗:", err));
    decoder.once("end", () => {
      this.capturing.delete(userId);
      if (size < 48_000 * 4 / 4) return; // 少於約 250ms，多半是雜音。
      const pcm = stereo48kToMono16k(Buffer.concat(chunks, size));
      void this.processUtterance(pcm);
    });
  }

  private async processUtterance(pcm: Buffer): Promise<void> {
    const currentServices = getDiscordVoiceServices();
    const textChannelId = this.textChannelId;
    const userId = this.activeUserId;
    if (!currentServices || !textChannelId || !userId || this.processing) return;
    this.processing = true;
    try {
      const transcript = (await currentServices.transcribe(pcm)).trim();
      if (!transcript) return;
      const outgoing = await this.dispatch({
        channel: "discord",
        senderId: userId,
        senderName: this.activeUserName,
        chatId: textChannelId,
        text: transcript,
        at: new Date(),
        _raw: { source: "discord-voice", guildId: this.guildId },
      });
      const reply = outgoing?.parts
        .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!reply || !this.connection || !this.player) return;
      const audioPart = outgoing?.parts.find(
        (part): part is Extract<typeof part, { kind: "audio" }> => part.kind === "audio",
      );
      const speech = audioPart
        ? {
            audio: await fs.readFile(audioPart.filePath),
            format: audioPart.mime === "audio/wav" ? "wav" as const : "mp3" as const,
          }
        : await currentServices.synthesize(reply);
      if (!speech?.audio.length || !this.connection || !this.player) return;
      this.speaking = true;
      this.player.play(createAudioResource(Readable.from(speech.audio), { inputType: StreamType.Arbitrary }));
    } catch (err) {
      console.error(LOG, "語音輪次失敗:", err);
      const channel = await this.client.channels.fetch(textChannelId).catch(() => null);
      if (channel?.isSendable()) {
        await channel.send(`語音通話暫時失敗：${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
      }
    } finally {
      this.processing = false;
    }
  }
}
