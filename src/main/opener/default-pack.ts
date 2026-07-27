import type { Manifest } from "./opener-types";

const scene = (items: Array<[string, string]>, cooldownMs: number, todayFiredFlag: string | null = null) => ({
  todayFiredFlag,
  cooldownMs,
  recentAvoidN: 1,
  items: items.map(([id, text]) => ({ id, text })),
});

/** 沒安裝 wav 語音包時的 0 token 文字後備，確保功能不會靜默失效。 */
export const BUILT_IN_TEXT_MANIFEST: Manifest = {
  version: 1,
  packs: {
    morning: scene([
      ["builtin-morning-1", "早安呀。今天也不用急，我們慢慢把一天打開就好。"],
      ["builtin-morning-2", "醒來了嗎？先喝口水，再讓我陪你看看今天。"],
    ], 36_000_000, "morning"),
    late_night: scene([
      ["builtin-night-1", "已經很晚了。剩下的事，明天的你也接得住。"],
      ["builtin-night-2", "夜深了，我還在。不過眼睛也該休息一下啦。"],
    ], 7_200_000, "late_night"),
    idle_daze: scene([
      ["builtin-idle-1", "發了一會兒呆嗎？沒關係，安靜也是一天的一部分。"],
      ["builtin-idle-2", "我剛才也在陪你放空。要不要伸個懶腰？"],
    ], 3_600_000),
    work_break: scene([
      ["builtin-break-1", "專心很久了呢。肩膀放鬆一下，再繼續也不遲。"],
      ["builtin-break-2", "休息一小會吧，我替你看著還沒做完的事。"],
    ], 7_200_000),
    back_from_away: scene([
      ["builtin-back-1", "你回來啦。我一直在這裡，歡迎回來。"],
      ["builtin-back-2", "抓到你回來了。剛才有好好休息嗎？"],
    ], 1_800_000),
    rainy_day: scene([
      ["builtin-rain-1", "外面在下雨。出門記得帶傘，也別讓鞋襪濕掉了。"],
      ["builtin-rain-2", "雨聲很適合慢一點。今天也對自己溫柔些吧。"],
    ], 14_400_000, "weather"),
    cold_drop: scene([
      ["builtin-cold-1", "今天比昨天冷不少，多帶一件外套，好嗎？"],
      ["builtin-cold-2", "氣溫降下來了。手要暖暖的，別只顧著忙。"],
    ], 14_400_000, "weather"),
    sunny_day: scene([
      ["builtin-sun-1", "今天天氣很好。光落進來的樣子，讓我想起你。"],
      ["builtin-sun-2", "外面很舒服呢。有空的話，一起去曬一點陽光吧。"],
    ], 14_400_000, "weather"),
  },
};
