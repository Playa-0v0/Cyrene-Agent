import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import type { CloudFavorite } from "./favorites.js";

const YT_DLP_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const FFMPEG_RELEASE_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";

type RunningTrack = {
  favorite: CloudFavorite;
  ytDlp: ChildProcess;
  ffmpeg: ChildProcess;
};

export class CloudMusicPlayer {
  private readonly player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  private connection: VoiceConnection | null = null;
  private queue: CloudFavorite[] = [];
  private running: RunningTrack | null = null;
  private advancing = false;
  private toolsPromise: Promise<{ ytDlp: string; ffmpeg: string }> | null = null;

  constructor(private readonly dataDir: string) {
    this.player.on(AudioPlayerStatus.Idle, () => void this.advance());
    this.player.on("error", (error) => {
      console.error("[CloudMusic] 播放器錯誤", error);
      void this.advance();
    });
  }

  async playFavorites(channel: VoiceBasedChannel, entries: CloudFavorite[]): Promise<CloudFavorite> {
    if (!entries.length) throw new Error("雲端收藏目前是空的，請先使用 /like 儲存歌曲。");
    if (!channel.joinable) throw new Error("我無法加入你的語音頻道，請檢查 Connect 與 Speak 權限。");

    this.stopProcesses();
    this.player.stop(true);
    this.connection?.destroy();
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection.subscribe(this.player);
    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void Promise.race([
        entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => this.stop());
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this.queue = [...entries];
    const first = this.queue[0];
    await this.advance();
    return first;
  }

  stop(): void {
    this.queue = [];
    this.stopProcesses();
    this.player.stop(true);
    try { this.connection?.destroy(); } catch { /* 已經斷線 */ }
    this.connection = null;
  }

  private async advance(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      this.stopProcesses();
      const favorite = this.queue.shift();
      if (!favorite || !this.connection) {
        this.stop();
        return;
      }
      const tools = await this.ensureTools();
      const ytDlp = spawn(tools.ytDlp, [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--format",
        "bestaudio/best",
        "--output",
        "-",
        favorite.url,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const ffmpeg = spawn(tools.ffmpeg, [
        "-hide_banner",
        "-loglevel", "warning",
        "-i", "pipe:0",
        "-vn",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      if (!ytDlp.stdout || !ffmpeg.stdin || !ffmpeg.stdout) throw new Error("無法建立雲端音訊管線。");
      ytDlp.stdout.pipe(ffmpeg.stdin);
      this.running = { favorite, ytDlp, ffmpeg };

      let ytError = "";
      let ffmpegError = "";
      ytDlp.stderr?.on("data", (chunk: Buffer) => { ytError = `${ytError}${chunk.toString("utf8")}`.slice(-1500); });
      ffmpeg.stderr?.on("data", (chunk: Buffer) => { ffmpegError = `${ffmpegError}${chunk.toString("utf8")}`.slice(-1500); });
      ytDlp.once("close", (code) => {
        if (code && this.running?.ytDlp === ytDlp) console.error(`[CloudMusic] yt-dlp 失敗 (${code})`, ytError);
      });
      ffmpeg.once("close", (code) => {
        if (code && this.running?.ffmpeg === ffmpeg) console.error(`[CloudMusic] ffmpeg 失敗 (${code})`, ffmpegError);
      });
      ytDlp.once("error", (error) => console.error("[CloudMusic] 無法啟動 yt-dlp", error));
      ffmpeg.once("error", (error) => console.error("[CloudMusic] 無法啟動 ffmpeg", error));

      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume?.setVolume(1);
      this.player.play(resource);
      console.log(`[CloudMusic] 開始播放：${favorite.title}`);
    } finally {
      this.advancing = false;
    }
  }

  private stopProcesses(): void {
    const current = this.running;
    this.running = null;
    if (!current) return;
    for (const process of [current.ytDlp, current.ffmpeg]) {
      if (process.exitCode === null && !process.killed) process.kill("SIGKILL");
    }
  }

  private async ensureTools(): Promise<{ ytDlp: string; ffmpeg: string }> {
    if (!this.toolsPromise) {
      const toolsDir = path.join(this.dataDir, "tools");
      this.toolsPromise = Promise.all([
        ensureYtDlp(toolsDir),
        ensureFfmpeg(toolsDir),
      ]).then(([ytDlp, ffmpeg]) => ({ ytDlp, ffmpeg })).catch((error) => {
        this.toolsPromise = null;
        throw error;
      });
    }
    return await this.toolsPromise;
  }
}

function platformAsset(kind: "yt-dlp" | "ffmpeg"): string {
  if (process.platform !== "linux") throw new Error(`雲端播放器目前不支援 ${process.platform}/${process.arch}`);
  if (process.arch === "x64") return kind === "yt-dlp" ? "yt-dlp_linux" : "ffmpeg-linux-x64.gz";
  if (process.arch === "arm64") return kind === "yt-dlp" ? "yt-dlp_linux_aarch64" : "ffmpeg-linux-arm64.gz";
  throw new Error(`雲端播放器目前不支援 ${process.platform}/${process.arch}`);
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`下載播放工具失敗（HTTP ${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

async function installExecutable(directory: string, fileName: string, contents: Buffer): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, fileName);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  return target;
}

async function ensureYtDlp(directory: string): Promise<string> {
  const asset = platformAsset("yt-dlp");
  const target = path.join(directory, asset);
  try {
    await access(target);
    return target;
  } catch { /* 第一次播放時安裝 */ }
  const [binary, checksums] = await Promise.all([
    fetchBuffer(`${YT_DLP_RELEASE_BASE}/${asset}`),
    fetchBuffer(`${YT_DLP_RELEASE_BASE}/SHA2-256SUMS`),
  ]);
  const expected = checksums.toString("utf8").split(/\r?\n/)
    .find((line) => line.trim().endsWith(asset))?.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || expected !== actual) throw new Error("yt-dlp 官方檔案驗證失敗。");
  return await installExecutable(directory, asset, binary);
}

async function ensureFfmpeg(directory: string): Promise<string> {
  const target = path.join(directory, "ffmpeg");
  try {
    await access(target);
    return target;
  } catch { /* 第一次播放時安裝 */ }
  const compressed = await fetchBuffer(`${FFMPEG_RELEASE_BASE}/${platformAsset("ffmpeg")}`);
  return await installExecutable(directory, "ffmpeg", gunzipSync(compressed));
}
