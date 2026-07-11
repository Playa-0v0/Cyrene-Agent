// channels settings-store 单元测试
// 重点验证 safeStorage encrypt/decrypt 边界 + 私有字段保存往返
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

// 必须在 mock 后 import
// eslint-disable-next-line import/first
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";

describe("channels/settings-store", () => {
  beforeEach(() => {
    // 每个测试前清掉磁盘文件（如果存在）
    const p = path.join(os.tmpdir(), "channels-settings.json");
    if (fs.existsSync(p)) fs.unlinkSync(p);
    encState.clear();
    encryptCalls = 0;
    decryptCalls = 0;
  });

  it("loadChannelsSettings: 不存在时返回默认值", () => {
    const cfg = loadChannelsSettings();
    expect(cfg.wechat.enabled).toBe(false);
    expect(cfg.feishu.enabled).toBe(false);
    expect(cfg.rateLimitPerUser).toBe(10);
  });

  it("saveChannelsSettings + load: 私密字段加密落盘 + 解密还原", () => {
    saveChannelsSettings({
      feishu: {
        enabled: true,
        appId: "cli_test_001",
        appSecret: "my-super-secret",
      },
    });
    // 磁盘上应该是 enc: 前缀密文
    const raw = fs.readFileSync(path.join(os.tmpdir(), "channels-settings.json"), "utf8");
    expect(raw).not.toContain("my-super-secret"); // 明文不落盘
    expect(raw).toContain("cli_test_001"); // 公开字段明文
    expect(raw).toContain('"appSecret": "enc:'); // 私密字段已加密
    // 加载回来：明文还原
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appId).toBe("cli_test_001");
    expect(loaded.feishu.appSecret).toBe("my-super-secret");
  });

  it("saveChannelsSettings: 不传 secret 不覆盖已有值", () => {
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "secret-1" } });
    // 第二次保存不传 secret
    saveChannelsSettings({ feishu: { enabled: false, appId: "cli_002" } });
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("secret-1"); // 保留
    expect(loaded.feishu.appId).toBe("cli_002");
    expect(loaded.feishu.enabled).toBe(false);
  });

  it("saveChannelsSettings: 传新 secret 覆盖", () => {
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "old" } });
    saveChannelsSettings({ feishu: { enabled: true, appSecret: "new" } });
    const loaded = loadChannelsSettings();
    expect(loaded.feishu.appSecret).toBe("new");
  });

  it("保存 QQ 主人、群聊触发和分段配置", () => {
    saveChannelsSettings({
      qq: {
        enabled: true,
        ownerQq: "3068238601",
        groupTriggerMode: "keyword",
        groupKeywords: ["昔涟", "Cyrene"],
        proactiveGroupEnabled: true,
        proactiveGroupProbability: 0,
        segmentedReplies: true,
        segmentContentThreshold: 240,
        segmentIntervalMode: "length",
        segmentMaxParts: 3,
      },
    });
    const loaded = loadChannelsSettings().qq;
    expect(loaded.ownerQq).toBe("3068238601");
    expect(loaded.groupTriggerMode).toBe("keyword");
    expect(loaded.groupKeywords).toEqual(["昔涟", "Cyrene"]);
    expect(loaded.proactiveGroupProbability).toBe(0);
    expect(loaded.segmentMaxParts).toBe(3);
    expect(loaded.segmentContentThreshold).toBe(240);
    expect(loaded.segmentIntervalMode).toBe("length");
  });
});
