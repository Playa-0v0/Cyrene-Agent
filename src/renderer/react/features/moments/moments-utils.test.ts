import { describe, expect, it } from "vitest";
import { formatMomentTime, getBackgroundLikers } from "./moments-utils";

// 固定参照时间：2026-09-04（周五）22:41:30 本地时间
const NOW = new Date(2026, 8, 4, 22, 41, 30).getTime();

describe("formatMomentTime", () => {
  it("一分钟内显示刚刚", () => {
    expect(formatMomentTime(NOW - 30_000, NOW)).toBe("刚刚");
    expect(formatMomentTime(NOW + 5_000, NOW)).toBe("刚刚"); // 未来时间容错
  });

  it("一小时内显示 n 分钟前", () => {
    expect(formatMomentTime(NOW - 3 * 60_000, NOW)).toBe("3 分钟前");
    expect(formatMomentTime(NOW - 59 * 60_000, NOW)).toBe("59 分钟前");
  });

  it("当天显示 HH:mm", () => {
    const morning = new Date(2026, 8, 4, 9, 5).getTime();
    expect(formatMomentTime(morning, NOW)).toBe("09:05");
  });

  it("昨天显示 昨天 HH:mm", () => {
    const yesterday = new Date(2026, 8, 3, 23, 59).getTime();
    expect(formatMomentTime(yesterday, NOW)).toBe("昨天 23:59");
  });

  it("同年更早显示 M月D日 HH:mm", () => {
    const earlier = new Date(2026, 0, 2, 8, 0).getTime();
    expect(formatMomentTime(earlier, NOW)).toBe("1月2日 08:00");
  });

  it("跨年显示完整日期", () => {
    const lastYear = new Date(2025, 11, 31, 23, 0).getTime();
    expect(formatMomentTime(lastYear, NOW)).toBe("2025年12月31日");
  });
});

describe("getBackgroundLikers", () => {
  it("同一动态 id 结果稳定（刷新/重渲染不闪变）", () => {
    expect(getBackgroundLikers("moment_p1")).toEqual(getBackgroundLikers("moment_p1"));
  });

  it("人数在 1~6 之间，不会全员齐点赞", () => {
    for (let i = 0; i < 200; i++) {
      const likers = getBackgroundLikers(`moment_seed_${i}`);
      expect(likers.length).toBeGreaterThanOrEqual(1);
      expect(likers.length).toBeLessThanOrEqual(6);
    }
  });

  it("结果是无重复的 12 人名单子集", () => {
    const all = new Set(["阿格莱雅", "白厄", "丹恒", "风堇", "海瑟音", "刻律德菈", "那刻夏", "赛飞儿", "缇宝", "万敌", "遐蝶", "长夜月"]);
    for (let i = 0; i < 50; i++) {
      const likers = getBackgroundLikers(`moment_subset_${i}`);
      expect(new Set(likers).size).toBe(likers.length);
      for (const name of likers) expect(all.has(name)).toBe(true);
    }
  });

  it("不同动态的点赞组合各不相同（随机感）", () => {
    const combos = new Set<string>();
    for (let i = 0; i < 50; i++) {
      combos.add(getBackgroundLikers(`moment_variety_${i}`).join(","));
    }
    // 50 条动态至少要出现 40 种不同组合，否则随机性不足
    expect(combos.size).toBeGreaterThanOrEqual(40);
  });
});
