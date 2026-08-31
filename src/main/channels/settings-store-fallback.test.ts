// settings-store 在 safeStorage 不可用时的行为测试。
// 这次的核心修复：safeStorage 不可用时不再返回空串，而是用机器指纹 XOR 混淆保存。
//
// 注意：vi.mock("electron") 在 vitest 跨文件是隔离的（每文件独立 worker），
// 但 settings-store 模块是 ESM singleton — 同一个 worker 内 isSafeStorageAvailable
// 是模块级 memo，所以本文件假设 mock 在文件加载时被读到。
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// 用独立子目录隔离 settings-store.test.ts（它用 os.tmpdir()）
const FALLBACK_TMP = path.join(os.tmpdir(), "cyrene-fallback-test");
fs.mkdirSync(FALLBACK_TMP, { recursive: true });

// Mock electron：safeStorage.isEncryptionAvailable → false
// app.getPath → 我们的子目录；app.getName → 固定字符串
vi.mock("electron", () => {
  return {
    app: {
      getPath: (_k: string) => FALLBACK_TMP,
      getName: () => "live2d-cyrene",
      isReady: () => true, // 模拟 ready 后 safeStorage 仍不可用（Linux/沙盒）
    },
    safeStorage: {
      isEncryptionAvailable: () => false, // 模拟 Linux/沙盒环境
      encryptString: (_plain: string) => {
        throw new Error("safeStorage 不可用 —— 不该被调用");
      },
      decryptString: (_buf: Buffer) => {
        throw new Error("safeStorage 不可用 —— 不该被调用");
      },
    },
  };
});

// eslint-disable-next-line import/first
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

describe("settings-store: safeStorage 不可用 fallback", () => {
  beforeEach(() => {
    const p = path.join(FALLBACK_TMP, "channels-settings.json");
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  it("fallback 测试环境就绪: FALLBACK_TMP 存在且 settings 文件不存在", () => {
    expect(fs.existsSync(FALLBACK_TMP)).toBe(true);
    expect(fs.existsSync(path.join(FALLBACK_TMP, "channels-settings.json"))).toBe(false);
  });

  it("save + load round-trip 在 fallback 模式下能还原明文（混淆成功）", () => {
    // 直接执行: save 明文 → 磁盘上应该不是明文 → load 回来应该能拿到明文
    saveChannelsSettings({
      feishu: { enabled: true, appSecret: "fallback-roundtrip" },
    });
    const loaded = loadChannelsSettings();
    // 核心断言: round-trip 后明文还在
    expect(loaded.feishu.appSecret).toBe("fallback-roundtrip");
  });

  it("save 时磁盘上不出现明文 secret（要么 enc: 要么 obf:）", () => {
    saveChannelsSettings({
      feishu: { enabled: true, appSecret: "obscured-secret-123" },
    });
    const raw = fs.readFileSync(path.join(FALLBACK_TMP, "channels-settings.json"), "utf8");
    expect(raw).not.toContain("obscured-secret-123");
    // 文件中要么是 enc: (safeStorage 可用) 要么是 obf: (fallback)
    expect(raw).toMatch(/"appSecret":\s*"(enc|obf):/);
  });

  it("二次保存不覆盖已有 secret", () => {
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "first-secret" } });
    saveChannelsSettings({ feishu: { enabled: false, appId: "cli_002" } });
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("first-secret");
    expect(loaded.feishu.appId).toBe("cli_002");
    expect(loaded.feishu.enabled).toBe(false);
  });

  it("预写入一个 obf: 字段到磁盘，load 能还原明文（模拟首次启动后磁盘已有数据）", () => {
    // 第一次 save → 让 settings-store 自动写 obf:
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "preboot-secret" } });
    // 此时磁盘上应该是 obf: 形式（因为 safeStorage 不可用），验证
    const raw = fs.readFileSync(path.join(FALLBACK_TMP, "channels-settings.json"), "utf8");
    expect(raw).toContain('"appSecret": "obf:'); // 确认走了 obfuscate

    // 不调用 save, 直接 load 看 round-trip
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("preboot-secret");
  });
});