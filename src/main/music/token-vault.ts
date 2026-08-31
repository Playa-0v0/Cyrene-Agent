// OpenAPI accessToken vault — CookieVault's successor for the refactored
// music backend. Persists the QR-login token bundle encrypted via
// Electron safeStorage (DPAPI on Windows), atomic tmp+rename writes.
import { safeStorage } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TokenBundlePayload {
  accessToken: string;
  refreshToken: string;
  /** Validity in seconds since `gotAt` (server: 86400 = 24h). */
  expireTime: number;
  /** Epoch ms when the bundle was obtained. */
  gotAt: number;
}

export interface EncryptedTokenBlob {
  formatVersion: 1;
  provider: "netease-openapi";
  savedAt: number;
  payload: Buffer;
}

const FORMAT_VERSION = 1 as const;
const PROVIDER = "netease-openapi" as const;
const FILENAME = "token.enc";

export class TokenVault {
  constructor(
    private readonly userDataMusicDir: string,
    private readonly storage: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString"> = safeStorage,
  ) {}

  private get tokenPath(): string {
    return path.join(this.userDataMusicDir, FILENAME);
  }

  async persist(payload: TokenBundlePayload): Promise<boolean> {
    const encrypted = this.storage.isEncryptionAvailable();
    if (!encrypted) {
      console.warn("[music] safeStorage 不可用，token 将以明文保存（不安全，仅 dev 用）");
    }
    const payloadJson = JSON.stringify(payload);
    const blob: EncryptedTokenBlob = {
      formatVersion: FORMAT_VERSION,
      provider: PROVIDER,
      savedAt: Date.now(),
      payload: encrypted
        ? this.storage.encryptString(payloadJson)
        : Buffer.from(payloadJson, "utf8"),
    };
    try {
      await fs.mkdir(this.userDataMusicDir, { recursive: true });
      const tmp = this.tokenPath + ".tmp";
      await fs.writeFile(tmp, this._serialize(blob));
      await fs.rename(tmp, this.tokenPath);
      console.log("[music] token 已保存到", this.tokenPath, encrypted ? "(加密)" : "(明文)");
      return true;
    } catch (err) {
      console.error("[music] token 保存失败：", err instanceof Error ? err.message : err);
      return false;
    }
  }

  async load(): Promise<EncryptedTokenBlob | null> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.tokenPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`E_TOKEN_BLOB_UNREADABLE: ${(e as Error).message}`);
    }
    let parsed: EncryptedTokenBlob;
    try {
      parsed = this._deserialize(raw);
    } catch (e: unknown) {
      throw new Error(`E_TOKEN_BLOB_UNREADABLE: ${(e as Error).message}`);
    }
    if (parsed.formatVersion !== FORMAT_VERSION) {
      throw new Error(`E_TOKEN_BLOB_UNREADABLE: formatVersion=${parsed.formatVersion}`);
    }
    if (parsed.provider !== PROVIDER) {
      throw new Error(`E_TOKEN_BLOB_UNREADABLE: provider=${parsed.provider}`);
    }
    return parsed;
  }

  async delete(): Promise<void> {
    await fs.rm(this.tokenPath, { force: true });
  }

  async decrypt(blob: EncryptedTokenBlob): Promise<TokenBundlePayload> {
    let json: string;
    // 兼容明文保存的 blob（safeStorage 不可用时的 fallback）
    if (blob.payload.length > 0 && blob.payload[0] === 0x7b /* '{' */) {
      json = blob.payload.toString("utf8");
    } else {
      json = this.storage.decryptString(blob.payload);
    }
    const data = JSON.parse(json) as TokenBundlePayload;
    if (!data.accessToken) throw new Error("E_TOKEN_BLOB_UNREADABLE: missing accessToken");
    return data;
  }

  /** True when the access token is within its 24h validity window. */
  isFresh(bundle: TokenBundlePayload, now = Date.now()): boolean {
    return now < bundle.gotAt + bundle.expireTime * 1000;
  }

  private _serialize(blob: EncryptedTokenBlob): Buffer {
    return Buffer.from(JSON.stringify({
      formatVersion: blob.formatVersion,
      provider: blob.provider,
      savedAt: blob.savedAt,
      payloadB64: blob.payload.toString("base64"),
    }));
  }

  private _deserialize(raw: Buffer): EncryptedTokenBlob {
    const obj = JSON.parse(raw.toString("utf8")) as {
      formatVersion: number;
      provider: string;
      savedAt: number;
      payloadB64: string;
    };
    return {
      formatVersion: obj.formatVersion as 1,
      provider: obj.provider as "netease-openapi",
      savedAt: obj.savedAt,
      payload: Buffer.from(obj.payloadB64, "base64"),
    };
  }
}
