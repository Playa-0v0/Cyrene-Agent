// OpenAPI credential config (appId + privateKey), stored as a plain JSON file
// under userData/music/netease — written by the renderer settings panel.
// Plain-file (not safeStorage): the key must survive reinstalls/DC sync per
// user workflow; tokens stay in TokenVault.
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface OpenapiConfig {
  appId: string;
  /** Raw base64 private key or pre-wrapped PKCS#8 PEM. */
  privateKey: string;
}

const FILENAME = "openapi-config.json";

export class OpenapiConfigStore {
  constructor(private readonly configDir: string) {}

  private get configPath(): string {
    return path.join(this.configDir, FILENAME);
  }

  /** Returns null when not configured yet; throws on a corrupt file. */
  async load(): Promise<OpenapiConfig | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, "utf8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`E_OPENAPI_CONFIG_UNREADABLE: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      throw new Error(`E_OPENAPI_CONFIG_UNREADABLE: ${(e as Error).message}`);
    }
    const cfg = parsed as Partial<OpenapiConfig>;
    if (typeof cfg.appId !== "string" || typeof cfg.privateKey !== "string") {
      throw new Error("E_OPENAPI_CONFIG_UNREADABLE: appId/privateKey missing");
    }
    return { appId: cfg.appId, privateKey: cfg.privateKey };
  }

  async save(config: OpenapiConfig): Promise<void> {
    validateOpenapiConfig(config);
    await fs.mkdir(this.configDir, { recursive: true });
    const tmp = this.configPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await fs.rename(tmp, this.configPath);
  }

  async delete(): Promise<void> {
    await fs.rm(this.configPath, { force: true });
  }

  /** Resolved ready-to-use config, or null when absent/incomplete. */
  async loadValidated(): Promise<OpenapiConfig | null> {
    const cfg = await this.load();
    if (!cfg) return null;
    try {
      validateOpenapiConfig(cfg);
      return cfg;
    } catch {
      return null;
    }
  }
}

export function validateOpenapiConfig(config: Partial<OpenapiConfig>): asserts config is OpenapiConfig {
  if (!config.appId || typeof config.appId !== "string") {
    throw new Error("E_OPENAPI_CONFIG_INVALID: appId required");
  }
  const pk = config.privateKey;
  if (!pk || typeof pk !== "string") {
    throw new Error("E_OPENAPI_CONFIG_INVALID: privateKey required");
  }
  if (pk.includes("BEGIN PRIVATE KEY")) return; // pre-wrapped PEM
  const bare = pk.replace(/\s+/g, "");
  if (bare.length < 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(bare)) {
    throw new Error("E_OPENAPI_CONFIG_INVALID: privateKey must be base64 or PEM");
  }
}
