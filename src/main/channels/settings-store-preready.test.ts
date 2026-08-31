// settings-store 在 app ready 之前的行为测试（2026-08-27 修复）。
// 核心回归点：isSafeStorageAvailable 在 ready 前返回 false 但【不写缓存】，
// 否则模块加载期的早期调用（channelDispatcher 是模块级单例）会把 false
// 永久缓存 → 之后 enc: 字段全部解密失败、加密全部降级混淆。
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PREREADY_TMP = path.join(os.tmpdir(), "cyrene-preready-test");
fs.mkdirSync(PREREADY_TMP, { recursive: true });

// 可变状态：先模拟 ready 前，再翻转成 ready 后
let appReady = false;
let storageAvailable = false;

vi.mock("electron", () => {
  return {
    app: {
      getPath: (_k: string) => PREREADY_TMP,
      getName: () => "live2d-cyrene",
      isReady: () => appReady,
    },
    safeStorage: {
      isEncryptionAvailable: () => storageAvailable,
      encryptString: (plain: string) => Buffer.from("ENC(" + plain + ")"),
      decryptString: (buf: Buffer) => buf.toString("utf8").slice("ENC(".length, -1),
    },
  };
});

// eslint-disable-next-line import/first
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

describe("settings-store: app ready 前不缓存 safeStorage=false", () => {
  beforeEach(() => {
    const p = path.join(PREREADY_TMP, "channels-settings.json");
    if (fs.existsSync(p)) fs.unlinkSync(p);
    appReady = false;
    storageAvailable = false;
  });

  it("ready 前 encrypt 走混淆（obf:），ready 后同进程恢复 enc:（false 未被缓存）", () => {
    // ready 前（模块加载期）：safeStorage 探测 false → 混淆落盘
    saveChannelsSettings({ feishu: { enabled: true, appId: "app-1", appSecret: "secret-plain" } });
    let onDisk = JSON.parse(fs.readFileSync(path.join(PREREADY_TMP, "channels-settings.json"), "utf8"));
    expect(onDisk.feishu.appSecret).toMatch(/^obf:/);

    // ready 之后 safeStorage 变可用：加密必须恢复 enc:（证明 false 没被缓存）
    appReady = true;
    storageAvailable = true;
    saveChannelsSettings({ feishu: { enabled: true, appId: "app-1", appSecret: "secret-plain-2" } });
    onDisk = JSON.parse(fs.readFileSync(path.join(PREREADY_TMP, "channels-settings.json"), "utf8"));
    expect(onDisk.feishu.appSecret).toMatch(/^enc:/);

    // load 还原明文
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("secret-plain-2");
  });
});
