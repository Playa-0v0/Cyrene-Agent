// settings-store 在 safeStorage 不可用時的行為測試。
// 這次的核心修復：safeStorage 不可用時不再返回空串，而是用機器指紋 XOR 混淆保存。
//
// 注意：vi.mock("electron") 在 vitest 跨文件是隔離的（每文件獨立 worker），
// 但 settings-store 模塊是 ESM singleton — 同一個 worker 內 isSafeStorageAvailable
// 是模塊級 memo，所以本文件假設 mock 在文件加載時被讀到。
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// 用獨立子目錄隔離 settings-store.test.ts（它用 os.tmpdir()）
const FALLBACK_TMP = path.join(os.tmpdir(), "cyrene-fallback-test");
fs.mkdirSync(FALLBACK_TMP, { recursive: true });

// Mock electron：safeStorage.isEncryptionAvailable → false
// app.getPath → 我們的子目錄；app.getName → 固定字符串
vi.mock("electron", () => {
  return {
    app: {
      getPath: (_k: string) => FALLBACK_TMP,
      getName: () => "live2d-cyrene",
    },
    safeStorage: {
      isEncryptionAvailable: () => false, // 模擬 Linux/沙盒環境
      encryptString: (_plain: string) => {
        throw new Error("safeStorage 不可用 —— 不該被調用");
      },
      decryptString: (_buf: Buffer) => {
        throw new Error("safeStorage 不可用 —— 不該被調用");
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

  it("fallback 測試環境就緒: FALLBACK_TMP 存在且 settings 文件不存在", () => {
    expect(fs.existsSync(FALLBACK_TMP)).toBe(true);
    expect(fs.existsSync(path.join(FALLBACK_TMP, "channels-settings.json"))).toBe(false);
  });

  it("save + load round-trip 在 fallback 模式下能還原明文（混淆成功）", () => {
    // 直接執行: save 明文 → 磁盤上應該不是明文 → load 回來應該能拿到明文
    saveChannelsSettings({
      feishu: { enabled: true, appSecret: "fallback-roundtrip" },
    });
    const loaded = loadChannelsSettings();
    // 核心斷言: round-trip 後明文還在
    expect(loaded.feishu.appSecret).toBe("fallback-roundtrip");
  });

  it("save 時磁盤上不出現明文 secret（要麼 enc: 要麼 obf:）", () => {
    saveChannelsSettings({
      feishu: { enabled: true, appSecret: "obscured-secret-123" },
    });
    const raw = fs.readFileSync(path.join(FALLBACK_TMP, "channels-settings.json"), "utf8");
    expect(raw).not.toContain("obscured-secret-123");
    // 文件中要麼是 enc: (safeStorage 可用) 要麼是 obf: (fallback)
    expect(raw).toMatch(/"appSecret":\s*"(enc|obf):/);
  });

  it("二次保存不覆蓋已有 secret", () => {
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "first-secret" } });
    saveChannelsSettings({ feishu: { enabled: false, appId: "cli_002" } });
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("first-secret");
    expect(loaded.feishu.appId).toBe("cli_002");
    expect(loaded.feishu.enabled).toBe(false);
  });

  it("預寫入一個 obf: 字段到磁盤，load 能還原明文（模擬首次啟動後磁盤已有數據）", () => {
    // 第一次 save → 讓 settings-store 自動寫 obf:
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "preboot-secret" } });
    // 此時磁盤上應該是 obf: 形式（因為 safeStorage 不可用），驗證
    const raw = fs.readFileSync(path.join(FALLBACK_TMP, "channels-settings.json"), "utf8");
    expect(raw).toContain('"appSecret": "obf:'); // 確認走了 obfuscate

    // 不調用 save, 直接 load 看 round-trip
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("preboot-secret");
  });
});