// 表情包系統的共享類型（main / renderer 共用）

/** 內置表情包 ID 列表（用於渲染端判斷來源） */
export const BUILT_IN_STICKER_IDS = [
  "playful",
  "love-happy",
  "confident",
  "serious",
  "calm",
  "peek",
  "clingy-confused",
  "love-calm",
  "HI",
  "hello",
  "goodmoring1",
  "goodnight",
  "teatime",
  "eating",
  "Allset",
  "OK",
  "copythat",
  "Thumbsup",
  "awesome",
  "sogood",
  "sonice",
  "fighting",
  "hellyeah",
  "Thanks",
  "foryou",
  "blushhard",
  "shyshort",
  "hmph",
  "hugtight",
  "Airkiss",
  "Gigglelots",
  "thinking",
  "putmd",
  "Whatswrong",
  "midmeh",
  "awkward",
  "Madnow",
  "Hurtcry",
  "Sobbinghard",
  "weeploud",
  "PanincCrying",
  "missme",
  "Free",
  "Dreak",
  "outfast",
  "Vcayover",
  "sleepynow",
  "deadtired",
  "sotired",
  "giveup",
  "poorwallet",
  "please",
] as const;

/** 內置 sticker ID 的 union 類型 */
export type BuiltInStickerId = (typeof BUILT_IN_STICKER_IDS)[number];

/** 任意表情包 ID（內置 ID 或用戶自定義字符串） */
export type AnyStickerId = string;

/** 用戶新增 sticker 的元數據（存於 userData/sticker-manifest.json） */
export interface UserStickerMeta {
  id: string;
  file: string;
  description: string;
  phrases: string[];
  createdAt: number;
}

/** 表情包管理窗口用的配置項 */
export interface StickerConfigItem {
  id: string;
  src: string;
  enabled: boolean;
  builtIn: boolean;
  description?: string;
}

/** 表情包大小 */
export type StickerSize = "small" | "standard" | "large";