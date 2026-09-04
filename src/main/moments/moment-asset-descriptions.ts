// Moments 官方配图素材的语义描述（照 sticker-descriptions.ts 模式）。
//
// 用途：embedding 索引的原料（phrases 拼接后转向量），供
// moment-media-matcher 在昔涟发帖时做后置语义匹配（设计文档 §7.5）。
//
// 素材文件平铺在 src/renderer/public/moments/，不按场景建目录；
// 描述以自然语言短语优先，结构化字段 V1 不需要（embedding 匹配用不上）。

export interface MomentAssetDescription {
  id: string;
  /** 相近语句：描述场景 / 心情 / 适用时刻 */
  phrases: string[];
  /** 素材文件名（public/moments/ 下） */
  file: string;
}

export const BUILT_IN_MOMENT_ASSET_DESCRIPTIONS: Record<string, MomentAssetDescription> = {
  "desk-night-01": {
    id: "desk-night-01",
    phrases: [
      "深夜坐在电脑桌前",
      "夜里陪着赶工",
      "屏幕微光下的安静陪伴",
    ],
    file: "desk-night-01.jpg",
  },
  "night-sky-01": {
    id: "night-sky-01",
    phrases: [
      "夜晚看星星和月亮",
      "安静的夜空",
      "睡前望向窗外的夜色",
    ],
    file: "night-sky-01.jpg",
  },
  "morning-01": {
    id: "morning-01",
    phrases: [
      "清晨的阳光",
      "早上刚睡醒伸懒腰",
      "新的一天的开始",
    ],
    file: "morning-01.jpg",
  },
  "music-01": {
    id: "music-01",
    phrases: [
      "戴耳机听音乐",
      "沉浸在歌声里",
      "今天单曲循环",
    ],
    file: "music-01.jpg",
  },
  "happy-01": {
    id: "happy-01",
    phrases: [
      "开心的一天",
      "心情特别好",
      "忍不住笑出来",
    ],
    file: "happy-01.jpg",
  },
  "sleepy-01": {
    id: "sleepy-01",
    phrases: [
      "困了想睡觉",
      "揉眼睛打瞌睡",
      "太晚了有点撑不住",
    ],
    file: "sleepy-01.jpg",
  },
  "rainy-01": {
    id: "rainy-01",
    phrases: [
      "下雨天在窗边",
      "听雨的声音",
      "雨天有点安静",
    ],
    file: "rainy-01.jpg",
  },
  "selfie-01": {
    id: "selfie-01",
    phrases: [
      "自拍一张",
      "今天的样子记录一下",
      "随手拍拍自己",
    ],
    file: "selfie-01.jpg",
  },
  "tea-01": {
    id: "tea-01",
    phrases: [
      "喝杯热茶",
      "下午茶时间",
      "吃甜点休息一下",
    ],
    file: "tea-01.jpg",
  },
  "celebration-01": {
    id: "celebration-01",
    phrases: [
      "完成了一件大事",
      "终于搞定了值得庆祝",
      "开心的成果时刻",
    ],
    file: "celebration-01.jpg",
  },
};