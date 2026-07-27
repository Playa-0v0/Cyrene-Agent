import { describe, it, expect } from "vitest";
import { parseManifest, pickItem } from "./opener-pack-store";

const MANIFEST = {
  version: 1,
  packs: {
    morning: {
      todayFiredFlag: "morning", cooldownMs: 36000000, recentAvoidN: 0,
      items: [
        { id: "m01", text: "早。", audio: "morning/m01.wav" },
        { id: "m02", text: "懶蟲。", audio: "morning/m02.wav", condition: { hourGte: 10 } },
      ],
    },
  },
};

describe("parseManifest", () => {
  it("合法 manifest 返回對象", () => {
    const m = parseManifest(JSON.stringify(MANIFEST));
    expect(m?.packs.morning.items.length).toBe(2);
  });
  it("非法 JSON 返回 null", () => {
    expect(parseManifest("not json")).toBeNull();
  });
  it("缺 version 返回 null", () => {
    expect(parseManifest(JSON.stringify({ packs: {} }))).toBeNull();
  });
});

describe("pickItem", () => {
  it("過濾掉 condition 不滿足的 item", () => {
    const items = MANIFEST.packs.morning.items;
    // hour=9 → m02 的 hourGte:10 不滿足，只剩 m01
    const picked = pickItem(items, 9, []);
    expect(picked?.id).toBe("m01");
  });
  it("hour=11 時 m02 也可被抽中（排除 m01 後只剩 m02）", () => {
    const items = MANIFEST.packs.morning.items;
    const picked = pickItem(items, 11, ["m01"]);
    expect(picked?.id).toBe("m02");
  });
  it("recentAvoidN 排除最近播過的", () => {
    const items = MANIFEST.packs.morning.items;
    // hour=11 兩個都可選，但 m01 在 recent 裡 → 只剩 m02
    const picked = pickItem(items, 11, ["m01"]);
    expect(picked?.id).toBe("m02");
  });
  it("全部都在最近清單時重新循環，避免背景持續空轉", () => {
    const items = MANIFEST.packs.morning.items;
    expect(["m01", "m02"]).toContain(pickItem(items, 11, ["m01", "m02"])?.id);
  });
  it("條件真的沒有任何可用項目時返回 null", () => {
    const conditionalOnly = [MANIFEST.packs.morning.items[1]];
    expect(pickItem(conditionalOnly, 9, [])).toBeNull();
  });
});
