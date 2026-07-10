import * as path from "path";
import { describe, it, expect, vi } from "vitest";

const { mockApp } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((_name: string) => path.join("C:", "Users", "tester", "AppData", "Roaming", "live2d-cyrene")),
  },
}));

vi.mock("electron", () => ({ app: mockApp }));

import { getOpenerPackDir, parseManifest, pickItem } from "./opener-pack-store";

const MANIFEST = {
  version: 1,
  packs: {
    morning: {
      todayFiredFlag: "morning", cooldownMs: 36000000, recentAvoidN: 0,
      items: [
        { id: "m01", text: "早。", audio: "morning/m01.wav" },
        { id: "m02", text: "懒虫。", audio: "morning/m02.wav", condition: { hourGte: 10 } },
      ],
    },
  },
};

describe("parseManifest", () => {
  it("合法 manifest 返回对象", () => {
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
  it("过滤掉 condition 不满足的 item", () => {
    const items = MANIFEST.packs.morning.items;
    // hour=9 → m02 的 hourGte:10 不满足，只剩 m01
    const picked = pickItem(items, 9, []);
    expect(picked?.id).toBe("m01");
  });
  it("hour=11 时 m02 也可被抽中（排除 m01 后只剩 m02）", () => {
    const items = MANIFEST.packs.morning.items;
    const picked = pickItem(items, 11, ["m01"]);
    expect(picked?.id).toBe("m02");
  });
  it("recentAvoidN 排除最近播过的", () => {
    const items = MANIFEST.packs.morning.items;
    // hour=11 两个都可选，但 m01 在 recent 里 → 只剩 m02
    const picked = pickItem(items, 11, ["m01"]);
    expect(picked?.id).toBe("m02");
  });
  it("全部被排除时返回 null", () => {
    const items = MANIFEST.packs.morning.items;
    expect(pickItem(items, 11, ["m01", "m02"])).toBeNull();
  });
});

describe("getOpenerPackDir", () => {
  it("源码运行时读取项目根目录 opener-pack", () => {
    mockApp.isPackaged = false;

    expect(getOpenerPackDir()).toBe(path.join(process.cwd(), "opener-pack"));
  });

  it("打包后读取 userData/cyrene-opener-pack", () => {
    mockApp.isPackaged = true;

    expect(getOpenerPackDir()).toBe(path.join(mockApp.getPath("userData"), "cyrene-opener-pack"));
  });
});
