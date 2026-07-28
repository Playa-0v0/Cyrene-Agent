// channels 配置存取：userData/channels-settings.json
//
// 照 index.ts 的 GeneralSettings 模式：load / save / normalize 三件套。
// 唯一碰 electron（app.getPath）。
//
// 字段安全分級：
//   - 公開字段（開關、端口、白名單）：明文存
//   - 私密字段（飛書 AppSecret/Token/Encrypt Key）：加密落盤。
//
// 加密策略（按優先級）：
//   1. safeStorage（OS 鑰匙串：Windows DPAPI / macOS Keychain / Linux libsecret）
//      → 存儲前綴 `enc:<base64>`
//   2. safeStorage 不可用時（headless / 沙盒 / libsecret 沒裝）：用機器指紋 XOR 混淆
//      → 存儲前綴 `obf:<base64>` —— 不是真加密，但能擋住 cat / grep 這種偷窺
//
// 為什麼這樣：
//   - 單純回退到明文會讓"重啟後 secret 丟失"成為靜默 bug（用戶根本不知道）
//   - 混淆雖然不抗逆向，但保證 secret 至少能 round-trip（重啟後能恢復）
//   - 如果將來發現 safeStorage 不可用且用戶在意安全，加一個設置項讓他們輸口令加密
import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
import type { ChannelId } from "./types";

/** safeStorage 加密後的前綴。讀取時遇到這個前綴就解密 */
const ENC_PREFIX = "enc:";
/** base64 混淆前綴（safeStorage 不可用時的兜底，可 round-trip 但不抗逆向） */
const OBF_PREFIX = "obf:";
/** 明文兜底標記（舊版數據遷移用） */
const PLAIN_PREFIX = "plain:";

/** 檢測當前環境 safeStorage 是否可用。Linux 無 DISPLAY 時不可用。 */
let safeStorageAvailable: boolean | null = null;
function isSafeStorageAvailable(): boolean {
  if (safeStorageAvailable === true) return true;
  try {
    const available = safeStorage.isEncryptionAvailable();
    // Electron 模組可能在 app.whenReady() 前被載入；那時 macOS Keychain 會暫時回 false。
    // 只快取成功，失敗狀態留給稍後 adapter 啟動時重新檢查。
    if (available) safeStorageAvailable = true;
    return available;
  } catch {
    return false;
  }
}

/** 機器指紋 XOR 混淆 key —— 不抗逆向但保證 round-trip。
 *  用 userData 絕對路徑 + 包名做 SHA256 → 16 字節。 */
function getMachineKey(): Buffer {
  const seed = `${app.getPath("userData")}::${app.getName()}::cyrene-bot-secret`;
  // 用 node 內置 crypto（避免依賴衝突）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(seed).digest().subarray(0, 16);
}

/** XOR 混淆（不是真加密，僅擋 casual 偷窺）。 */
function obfuscate(plain: string): string {
  const key = getMachineKey();
  const buf = Buffer.from(plain, "utf8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return OBF_PREFIX + out.toString("base64");
}

/** XOR 解混淆（必須和 obfuscate 用同一臺機器 —— key 派生自 userData 路徑）。 */
function deobfuscate(stored: string): string {
  const key = getMachineKey();
  const b64 = stored.slice(OBF_PREFIX.length);
  const buf = Buffer.from(b64, "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return out.toString("utf8");
}

/** 加密一個字符串。優先級: safeStorage > 機器指紋混淆 > 明文 */
function encryptField(plain: string): string {
  if (!plain) return "";
  if (isSafeStorageAvailable()) {
    try {
      const buf = safeStorage.encryptString(plain);
      return ENC_PREFIX + buf.toString("base64");
    } catch (err) {
      console.warn("[ChannelsSettings] safeStorage.encryptString 失敗, 回退混淆:", err);
    }
  }
  return obfuscate(plain);
}

/** 解密一個字符串。識別 enc:/obf:/plain: 前綴。空字符串返回空。 */
function decryptField(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith(ENC_PREFIX)) {
    if (!isSafeStorageAvailable()) {
      // safeStorage 不可用時 enc: 解不開 —— 這種情況通常意味著首次加密時也沒用 safeStorage
      // 兜底：直接 base64 解碼（會拿到亂碼但不會讓用戶丟失 secret）
      console.warn("[ChannelsSettings] safeStorage 不可用, 無法解密 enc: 字段");
      return "";
    }
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.warn("[ChannelsSettings] safeStorage.decryptString 失敗:", err);
      return "";
    }
  }
  if (stored.startsWith(OBF_PREFIX)) {
    try {
      return deobfuscate(stored);
    } catch (err) {
      console.warn("[ChannelsSettings] deobfuscate 失敗:", err);
      return "";
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }
  // 舊數據 / 兜底：當作明文
  return stored;
}

export interface ChannelRuntimeConfig {
  /** 是否啟用本渠道 */
  enabled: boolean;
  /** 自定義 CLI 路徑（用戶手動指定時填，否則空走探測） */
  manualCliPath?: string;
  /** 用戶填的公網回調 URL（飛書等需要公網回調的渠道用） */
  publicWebhookUrl?: string;
}

export interface WechatChannelConfig extends ChannelRuntimeConfig {
  /** 待審批用戶列表（Phase 1 接入 OpenClaw pairing 後實裝） */
  pairingPending?: Array<{ code: string; senderId: string; createdAt: number }>;
  /** 當前掃碼登錄二維碼（base64 PNG），會話級不持久化 */
}

export interface FeishuChannelConfig extends ChannelRuntimeConfig {
  appId?: string;
  /**
   * AppSecret。**已用 safeStorage 加密**。讀取時直接用，不要再 decrypt。
   * 這是 loadChannelsSettings 返回"密文形態"——上游業務層想拿明文，調 decryptFeishuSecret(cfg.appSecret)。
   * 設置層（UI）保存時：把用戶輸入的明文先用 encryptField() 包裹再寫。
   */
  appSecret?: string;
}

export interface DiscordChannelConfig extends ChannelRuntimeConfig {
  /** Discord Bot Token；磁盤保存時由 safeStorage 加密。 */
  botToken?: string;
  /** 空陣列表示不限制；填寫後只接受指定 ID。 */
  allowedGuildIds?: string[];
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  /** 唯一可建立 Codex 圖片任務的 Discord 使用者；不隨一般聊天白名單擴張。 */
  codexImageOwnerId?: string;
  /** 伺服器頻道中是否必須直接 @Bot；私訊不受此項限制。 */
  requireMention?: boolean;
  /** 是否允許白名單使用者要求 Bot 加入 Discord 語音頻道通話。 */
  voiceEnabled?: boolean;
  /** Bot 在 Discord 顯示的上線狀態；重連後自動恢復。 */
  presenceStatus?: "online" | "idle" | "dnd" | "invisible";
  /** Bot 的「正在玩」活動文字；重連後自動恢復。 */
  activityText?: string;
  /** 雲端 Bot 為唯一 Discord Gateway；本機保留設定但不重複登入。 */
  cloudPrimary?: boolean;
  /** 雲端 Bot 的健康檢查 URL（例：https://xxx.onrender.com/health） */
  cloudPingUrl?: string;
  /** 桌面程式在線時由本機接管；心跳消失後由 VM 自動接手。 */
  cloudStandbyEnabled?: boolean;
  /** 自動接手 VM 的 SSH 連線資料；SSH 私鑰內容不會寫入設定檔。 */
  cloudStandbyHost?: string;
  cloudStandbyUser?: string;
  cloudStandbyKeyPath?: string;
}

/** Spotify Premium / Web API OAuth 設定。私密欄位一律加密落盤。 */
export interface SpotifyConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accountName?: string;
}

/** Bilibili 使用本機瀏覽器工作階段；不保存帳號、密碼或 Cookie。 */
export interface BilibiliConfig {
  enabled: boolean;
  browser?: "opera-gx";
}

/** 給上層用的明文 AppSecret 讀取器 */
export function decryptFeishuSecret(cfg: FeishuChannelConfig | undefined): string {
  return decryptField(cfg?.appSecret ?? "");
}

export interface ChannelsSettings {
  wechat: WechatChannelConfig;
  feishu: FeishuChannelConfig;
  discord: DiscordChannelConfig;
  spotify: SpotifyConfig;
  bilibili: BilibiliConfig;
  /** 入站 HTTP server 綁定的端口。0 = 隨機空閒。 */
  inboundPort: number;
  /** HMAC 共享密鑰。啟動時若為空則自動生成。 */
  sharedSecret: string;
  /** 全局：每用戶每分鐘最多消息數 */
  rateLimitPerUser: number;
  /** 全局：單渠道每分鐘最多消息數 */
  rateLimitPerChannel: number;
  /** 全局：是否發送 TTS 音頻消息 */
  ttsEnabled: boolean;
  /** 全局：是否發送 sticker */
  stickerEnabled: boolean;
  /** 全局：是否把 bot 會話鏡像到桌面端 chatWindow */
  mirrorToDesktop: boolean;
  /** 全局：工具沙箱 'safe-only' | 'all' */
  toolSandbox: "safe-only" | "all";
}

const DEFAULT_SETTINGS: ChannelsSettings = {
  wechat: { enabled: false },
  feishu: { enabled: false },
  discord: { enabled: false, requireMention: true, voiceEnabled: true, cloudPrimary: true },
  spotify: { enabled: false },
  bilibili: { enabled: false, browser: "opera-gx" },
  inboundPort: 0,
  sharedSecret: "",
  rateLimitPerUser: 10,
  rateLimitPerChannel: 100,
  ttsEnabled: true,
  stickerEnabled: true,
  mirrorToDesktop: true,
  toolSandbox: "safe-only",
};

function filePath(): string {
  return path.join(app.getPath("userData"), "channels-settings.json");
}

function normalize(input: Partial<ChannelsSettings> | null | undefined): ChannelsSettings {
  const safeNum = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const safeBool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;

  const safeStr = (v: unknown): string => (typeof v === "string" ? v : "");

  const w: Partial<WechatChannelConfig> | undefined = input?.wechat;
  const f: Partial<FeishuChannelConfig> | undefined = input?.feishu;
  const d: Partial<DiscordChannelConfig> | undefined = input?.discord;
  const s: Partial<SpotifyConfig> | undefined = input?.spotify;
  const b: Partial<BilibiliConfig> | undefined = input?.bilibili;
  const safeIds = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))]
    : [];

  return {
    wechat: {
      enabled: safeBool(w?.enabled, false),
      manualCliPath: typeof w?.manualCliPath === "string" ? w.manualCliPath : undefined,
      publicWebhookUrl: typeof w?.publicWebhookUrl === "string" ? w.publicWebhookUrl : undefined,
      pairingPending: Array.isArray(w?.pairingPending)
        ? w!.pairingPending!.map((p) => ({
            code: safeStr((p as { code?: unknown }).code),
            senderId: safeStr((p as { senderId?: unknown }).senderId),
            createdAt: safeNum((p as { createdAt?: unknown }).createdAt, Date.now()),
          }))
        : [],
    },
    feishu: {
      enabled: safeBool(f?.enabled, false),
      manualCliPath: typeof f?.manualCliPath === "string" ? f?.manualCliPath : undefined,
      publicWebhookUrl: typeof f?.publicWebhookUrl === "string" ? f?.publicWebhookUrl : undefined,
      appId: typeof f?.appId === "string" ? f?.appId : undefined,
      // appSecret 字段：對外 API 是明文，磁盤存儲是 enc: 前綴密文。
      // load 函數會先 decrypt 再返回；save 函數會自動 encrypt。
      appSecret: typeof f?.appSecret === "string" ? f?.appSecret : undefined,
    },
    discord: {
      enabled: safeBool(d?.enabled, false),
      botToken: typeof d?.botToken === "string" ? d.botToken : undefined,
      allowedGuildIds: safeIds(d?.allowedGuildIds),
      allowedChannelIds: safeIds(d?.allowedChannelIds),
      allowedUserIds: safeIds(d?.allowedUserIds),
      codexImageOwnerId: typeof d?.codexImageOwnerId === "string" && /^\d{15,22}$/.test(d.codexImageOwnerId.trim())
        ? d.codexImageOwnerId.trim()
        : undefined,
      requireMention: safeBool(d?.requireMention, true),
      voiceEnabled: safeBool(d?.voiceEnabled, true),
      cloudPrimary: safeBool(d?.cloudPrimary, true),
      cloudPingUrl: typeof d?.cloudPingUrl === "string" ? d.cloudPingUrl.trim() : undefined,
      cloudStandbyEnabled: safeBool(d?.cloudStandbyEnabled, false),
      cloudStandbyHost: typeof d?.cloudStandbyHost === "string" ? d.cloudStandbyHost.trim() : undefined,
      cloudStandbyUser: typeof d?.cloudStandbyUser === "string" ? d.cloudStandbyUser.trim() : undefined,
      cloudStandbyKeyPath: typeof d?.cloudStandbyKeyPath === "string" ? d.cloudStandbyKeyPath.trim() : undefined,
      ...(["online", "idle", "dnd", "invisible"].includes(d?.presenceStatus ?? "")
        ? { presenceStatus: d!.presenceStatus }
        : {}),
      ...(typeof d?.activityText === "string" ? { activityText: d.activityText.slice(0, 128) } : {}),
    },
    spotify: {
      enabled: safeBool(s?.enabled, false),
      clientId: typeof s?.clientId === "string" ? s.clientId.trim() : undefined,
      clientSecret: typeof s?.clientSecret === "string" ? s.clientSecret : undefined,
      refreshToken: typeof s?.refreshToken === "string" ? s.refreshToken : undefined,
      accountName: typeof s?.accountName === "string" ? s.accountName.slice(0, 160) : undefined,
    },
    bilibili: {
      enabled: safeBool(b?.enabled, false),
      browser: "opera-gx",
    },
    inboundPort: safeNum(input?.inboundPort, 0, 0, 65535),
    sharedSecret: typeof input?.sharedSecret === "string" ? input.sharedSecret : "",
    rateLimitPerUser: safeNum(input?.rateLimitPerUser, 10, 1, 1000),
    rateLimitPerChannel: safeNum(input?.rateLimitPerChannel, 100, 1, 10000),
    ttsEnabled: safeBool(input?.ttsEnabled, true),
    stickerEnabled: safeBool(input?.stickerEnabled, true),
    mirrorToDesktop: safeBool(input?.mirrorToDesktop, true),
    toolSandbox: input?.toolSandbox === "all" ? "all" : "safe-only",
  };
}

/** 不觸碰 Electron userData 或 safeStorage，可供 app ready 前建立安全的初始狀態。 */
export function getDefaultChannelsSettings(): ChannelsSettings {
  return normalize(DEFAULT_SETTINGS);
}

export function loadChannelsSettings(): ChannelsSettings {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ChannelsSettings>;
    const loaded = normalize(raw);
    // 私密字段解密邊界：磁盤上是 enc: 前綴密文，運行時 API 暴露明文
    if (loaded.feishu.appSecret) {
      loaded.feishu.appSecret = decryptField(loaded.feishu.appSecret);
    }
    if (loaded.discord.botToken) loaded.discord.botToken = decryptField(loaded.discord.botToken);
    if (loaded.spotify.clientSecret) loaded.spotify.clientSecret = decryptField(loaded.spotify.clientSecret);
    if (loaded.spotify.refreshToken) loaded.spotify.refreshToken = decryptField(loaded.spotify.refreshToken);
    return loaded;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 讀取磁碟原始形態；secret 仍維持 enc:/obf:，供 partial save 原樣保留。 */
function loadRawChannelsSettings(): Partial<ChannelsSettings> {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ChannelsSettings>;
  } catch {
    return {};
  }
}

export function saveChannelsSettings(patch: Partial<ChannelsSettings>): ChannelsSettings {
  const rawExisting = loadRawChannelsSettings();
  const existing = loadChannelsSettings();
  const merged: Partial<ChannelsSettings> = { ...existing, ...patch };
  if (patch.wechat) merged.wechat = { ...existing.wechat, ...patch.wechat };
  if (patch.feishu) merged.feishu = { ...existing.feishu, ...patch.feishu };
  if (patch.discord) merged.discord = { ...existing.discord, ...patch.discord };
  if (patch.spotify) merged.spotify = { ...existing.spotify, ...patch.spotify };
  if (patch.bilibili) merged.bilibili = { ...existing.bilibili, ...patch.bilibili };

  // Partial save 沒帶私密字段時，直接沿用磁碟密文，不能依賴「解密後再加密」。
  // macOS Keychain 暫時不可用、renderer 延遲自動保存等情況下，load 可能拿到空字串；
  // 若此時把空值寫回，就會永久清掉仍然有效的 Token/Secret。
  if (!patch.feishu?.appSecret && rawExisting.feishu?.appSecret) {
    merged.feishu = { ...merged.feishu!, appSecret: rawExisting.feishu.appSecret };
  }
  if (!patch.discord?.botToken && rawExisting.discord?.botToken) {
    merged.discord = { ...merged.discord!, botToken: rawExisting.discord.botToken };
  }
  if (!(patch.spotify && Object.prototype.hasOwnProperty.call(patch.spotify, "clientSecret")) && rawExisting.spotify?.clientSecret) {
    merged.spotify = { ...merged.spotify!, clientSecret: rawExisting.spotify.clientSecret };
  }
  if (!(patch.spotify && Object.prototype.hasOwnProperty.call(patch.spotify, "refreshToken")) && rawExisting.spotify?.refreshToken) {
    merged.spotify = { ...merged.spotify!, refreshToken: rawExisting.spotify.refreshToken };
  }

  // 私密字段加密邊界：UI 傳來的是明文，寫盤前要 wrap
  // 避開"密文回傳"場景：檢測 enc:/obf:/plain: 前綴，避免重複加密。
  if (typeof merged.feishu?.appSecret === "string" && merged.feishu.appSecret) {
    const v = merged.feishu.appSecret;
    if (!v.startsWith(ENC_PREFIX) && !v.startsWith(OBF_PREFIX) && !v.startsWith(PLAIN_PREFIX)) {
      merged.feishu.appSecret = encryptField(v);
    }
  }
  if (typeof merged.discord?.botToken === "string" && merged.discord.botToken) {
    const v = merged.discord.botToken;
    if (!v.startsWith(ENC_PREFIX) && !v.startsWith(OBF_PREFIX) && !v.startsWith(PLAIN_PREFIX)) {
      merged.discord.botToken = encryptField(v);
    }
  }
  for (const key of ["clientSecret", "refreshToken"] as const) {
    const value = merged.spotify?.[key];
    if (typeof value === "string" && value && !value.startsWith(ENC_PREFIX) && !value.startsWith(OBF_PREFIX) && !value.startsWith(PLAIN_PREFIX)) {
      merged.spotify = { ...merged.spotify!, [key]: encryptField(value) };
    }
  }

  const final = normalize(merged);
  // 寫盤時 final.appSecret / final.encryptKey 已經是密文形態（帶 enc: 前綴）
  // load 時解密，運行時給上層看到明文。
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(final, null, 2), "utf8");

  // 返回給上層時再解密一次，讓 API 用戶拿到明文
  const out: ChannelsSettings = {
    ...final,
    feishu: {
      ...final.feishu,
      appSecret: decryptField(final.feishu.appSecret ?? ""),
    },
    discord: {
      ...final.discord,
      botToken: decryptField(final.discord.botToken ?? ""),
    },
    spotify: {
      ...final.spotify,
      clientSecret: decryptField(final.spotify.clientSecret ?? ""),
      refreshToken: decryptField(final.spotify.refreshToken ?? ""),
    },
  };
  return out;
}

/** 渠道字段補丁類型（用於上層調用 saveChannelsSettings 時類型安全）。 */
export type ChannelConfigPatch = Partial<{
  wechat: Partial<WechatChannelConfig>;
  feishu: Partial<FeishuChannelConfig>;
  discord: Partial<DiscordChannelConfig>;
  spotify: Partial<SpotifyConfig>;
  bilibili: Partial<BilibiliConfig>;
  inboundPort: number;
  sharedSecret: string;
  rateLimitPerUser: number;
  rateLimitPerChannel: number;
  ttsEnabled: boolean;
  stickerEnabled: boolean;
  mirrorToDesktop: boolean;
  toolSandbox: "safe-only" | "all";
}>;

/** 給定 channelId 返回對應的配置子集（用於 adapter 內部讀取自己的開關）。 */
export function getChannelConfig<K extends ChannelId>(
  settings: ChannelsSettings,
  channel: K,
): K extends "wechat" ? WechatChannelConfig : K extends "feishu" ? FeishuChannelConfig : DiscordChannelConfig {
  return settings[channel] as K extends "wechat"
    ? WechatChannelConfig
    : K extends "feishu" ? FeishuChannelConfig : DiscordChannelConfig;
}
