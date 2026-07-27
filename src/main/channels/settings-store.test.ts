// channels settings-store 單元測試
// 重點驗證 safeStorage encrypt/decrypt 邊界 + 私有字段保存往返
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock electron 的 safeStorage（不需要真 keychain）
const encState = new Map<string, string>(); // plaintext → base64 密文
let encryptCalls = 0;
let decryptCalls = 0;

vi.mock("electron", () => {
  return {
    app: {
      getPath: (_k: string) => os.tmpdir(),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => {
        encryptCalls++;
        const fake = Buffer.from("ENC(" + plain + ")").toString("base64");
        encState.set(plain, fake);
        return Buffer.from(fake, "base64");
      },
      decryptString: (buf: Buffer) => {
        decryptCalls++;
        const b64 = buf.toString("base64");
        // 反查明文
        for (const [plain, stored] of encState.entries()) {
          if (stored === b64) return plain;
        }
        throw new Error("mock decrypt failed");
      },
    },
  };
});

// 必須在 mock 後 import
// eslint-disable-next-line import/first
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

describe("channels/settings-store", () => {
  beforeEach(() => {
    // 每個測試前清掉磁盤文件（如果存在）
    const p = path.join(os.tmpdir(), "channels-settings.json");
    if (fs.existsSync(p)) fs.unlinkSync(p);
    encState.clear();
    encryptCalls = 0;
    decryptCalls = 0;
  });

  it("loadChannelsSettings: 不存在時返回默認值", () => {
    const cfg = loadChannelsSettings();
    expect(cfg.wechat.enabled).toBe(false);
    expect(cfg.feishu.enabled).toBe(false);
    expect(cfg.bilibili).toEqual({ enabled: false, browser: "opera-gx" });
    expect(cfg.rateLimitPerUser).toBe(10);
  });

  it("Bilibili: 只保存本機瀏覽器連接狀態，不保存憑證", () => {
    saveChannelsSettings({ bilibili: { enabled: true, browser: "opera-gx" } });
    const raw = fs.readFileSync(path.join(os.tmpdir(), "channels-settings.json"), "utf8");
    expect(raw).toContain('"browser": "opera-gx"');
    expect(raw).not.toMatch(/cookie|password/i);
    expect(loadChannelsSettings().bilibili.enabled).toBe(true);
  });

  it("saveChannelsSettings + load: 私密字段加密落盤 + 解密還原", () => {
    saveChannelsSettings({
      feishu: {
        enabled: true,
        appId: "cli_test_001",
        appSecret: "my-super-secret",
      },
    });
    // 磁盤上應該是 enc: 前綴密文
    const raw = fs.readFileSync(path.join(os.tmpdir(), "channels-settings.json"), "utf8");
    expect(raw).not.toContain("my-super-secret"); // 明文不落盤
    expect(raw).toContain("cli_test_001"); // 公開字段明文
    expect(raw).toContain('"appSecret": "enc:'); // 私密字段已加密
    // 加載回來：明文還原
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appId).toBe("cli_test_001");
    expect(loaded.feishu.appSecret).toBe("my-super-secret");
  });

  it("saveChannelsSettings: 不傳 secret 不覆蓋已有值", () => {
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "secret-1" } });
    // 第二次保存不傳 secret
    saveChannelsSettings({ feishu: { enabled: false, appId: "cli_002" } });
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("secret-1"); // 保留
    expect(loaded.feishu.appId).toBe("cli_002");
    expect(loaded.feishu.enabled).toBe(false);
  });

  it("saveChannelsSettings: 傳新 secret 覆蓋", () => {
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "old" } });
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "new" } });
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("new");
  });

  it("Discord: 修改白名單時保留磁碟上的加密 Bot Token", () => {
    saveChannelsSettings({
      discord: { enabled: true, botToken: "discord-token", requireMention: true },
    });
    const p = path.join(os.tmpdir(), "channels-settings.json");
    const before = JSON.parse(fs.readFileSync(p, "utf8"));
    const encryptedBefore = before.discord.botToken;

    // 模擬 Keychain 暫時解不開舊密文；partial save 仍必須原樣保留磁碟密文。
    encState.clear();
    saveChannelsSettings({
      discord: { enabled: true, allowedUserIds: ["798893182883463179"] },
    });

    const after = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(after.discord.botToken).toBe(encryptedBefore);
    expect(after.discord.allowedUserIds).toEqual(["798893182883463179"]);
  });

  it("Spotify: 加密保存 Client Secret 與 Refresh Token，並允許解除授權", () => {
    saveChannelsSettings({ spotify: { enabled: true, clientId: "spotify-client", clientSecret: "spotify-secret", refreshToken: "spotify-refresh" } });
    const p = path.join(os.tmpdir(), "channels-settings.json");
    const raw = fs.readFileSync(p, "utf8");
    expect(raw).toContain("spotify-client");
    expect(raw).not.toContain("spotify-secret");
    expect(raw).not.toContain("spotify-refresh");
    expect(loadChannelsSettings().spotify.refreshToken).toBe("spotify-refresh");
    saveChannelsSettings({ spotify: { enabled: false, refreshToken: "" } });
    expect(loadChannelsSettings().spotify.refreshToken).toBe("");
    expect(loadChannelsSettings().spotify.clientSecret).toBe("spotify-secret");
  });
});
