// 表情包系统的共享类型（main / renderer 共用）

/** 内置表情包 ID 列表（用于渲染端判断来源） */
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

/** 内置 sticker ID 的 union 类型 */
export type BuiltInStickerId = (typeof BUILT_IN_STICKER_IDS)[number];

/** 任意表情包 ID（内置 ID 或用户自定义字符串） */
export type AnyStickerId = string;

/** 用户新增 sticker 的元数据（存于 userData/sticker-manifest.json） */
export interface UserStickerMeta {
  id: string;
  file: string;
  description: string;
  phrases: string[];
  createdAt: number;
}

/** 表情包管理窗口用的配置项 */
export interface StickerConfigItem {
  id: string;
  src: string;
  enabled: boolean;
  builtIn: boolean;
  description?: string;
}

/** 表情包大小 */
export type StickerSize = "small" | "standard" | "large";