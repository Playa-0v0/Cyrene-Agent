import { describe, expect, it } from "vitest";
import { formatMomentTime } from "./moments-utils";

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
