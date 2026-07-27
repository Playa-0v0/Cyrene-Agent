import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { createHash } from "crypto";
import { preserveCurrentSecrets, redactSecrets } from "./secret-vault";

export type BackupCategory = "conversations" | "memories" | "planning" | "personalization" | "knowledge" | "settings";

export const BACKUP_CATEGORY_LABELS: Record<BackupCategory, string> = {
  conversations: "聊天紀錄",
  memories: "記憶與關係",
  planning: "任務與生活紀錄",
  personalization: "個人化內容",
  knowledge: "知識庫",
  settings: "一般設定（不含密鑰）",
};

const CATEGORY_PATHS: Record<BackupCategory, string[]> = {
  conversations: ["cyrene-chats"],
  memories: ["memory.json", "entity-graph.json", "relationship-log.json", "worldbook-state.json"],
  planning: ["scheduled-tasks.json", "scheduled-tasks-history.jsonl", "current-todos.json", "expenses.json", "game-room-stats.json"],
  personalization: ["user-profile.json", "avatar.png", "sticker-settings.json", "sticker-manifest.json", "stickers", "skills-enabled.json", "skills", "cyrene-opener-pack"],
  knowledge: ["rag-data"],
  settings: ["app-settings.json", "model-settings.json"],
};

const ALL_CATEGORIES = Object.keys(CATEGORY_PATHS) as BackupCategory[];
const MAX_FILES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

interface BackupFile {
  category: BackupCategory;
  path: string;
  size: number;
  sha256: string;
  data: string;
}

interface BackupBundle {
  format: "cyrene-backup";
  version: 1;
  createdAt: string;
  appVersion: string;
  categories: BackupCategory[];
  files: BackupFile[];
}

export interface BackupSummary {
  filePath: string;
  createdAt: string;
  appVersion: string;
  categories: Array<{ id: BackupCategory; label: string; fileCount: number; sizeBytes: number }>;
  fileCount: number;
  sizeBytes: number;
}

export interface BackupConfig {
  autoEnabled: boolean;
  retentionDays: 7 | 30;
  lastAutoBackupAt?: string;
}

const DEFAULT_CONFIG: BackupConfig = { autoEnabled: false, retentionDays: 7 };

function isBackupCategory(value: unknown): value is BackupCategory {
  return typeof value === "string" && ALL_CATEGORIES.includes(value as BackupCategory);
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new Error("備份內含不安全的路徑");
  return normalized;
}

function atomicWrite(filePath: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function listFiles(root: string, relative: string): string[] {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(absolute).flatMap((name) => listFiles(root, path.join(relative, name)));
}

function readBackupFile(userData: string, relative: string, category: BackupCategory): BackupFile {
  let bytes = fs.readFileSync(path.join(userData, relative));
  if (category === "settings" && relative.endsWith(".json")) {
    try { bytes = Buffer.from(JSON.stringify(redactSecrets(JSON.parse(bytes.toString("utf8"))), null, 2), "utf8"); } catch { /* preserve malformed data */ }
  }
  return {
    category,
    path: relative.replace(/\\/g, "/"),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: bytes.toString("base64"),
  };
}

function parseBundle(filePath: string): BackupBundle {
  const compressed = fs.readFileSync(filePath);
  const raw = zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  const bundle = JSON.parse(raw.toString("utf8")) as Partial<BackupBundle>;
  if (bundle.format !== "cyrene-backup" || bundle.version !== 1 || !Array.isArray(bundle.files) || !Array.isArray(bundle.categories)) throw new Error("這不是有效的昔漣備份檔");
  if (bundle.files.length > MAX_FILES) throw new Error("備份檔案數量超過安全限制");
  for (const file of bundle.files) {
    if (!file || !isBackupCategory(file.category)) throw new Error("備份分類無效");
    safeRelativePath(file.path);
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`備份檔案校驗失敗：${file.path}`);
  }
  return bundle as BackupBundle;
}

function summarize(bundle: BackupBundle, filePath: string): BackupSummary {
  return {
    filePath,
    createdAt: bundle.createdAt,
    appVersion: bundle.appVersion,
    categories: bundle.categories.map((id) => {
      const files = bundle.files.filter((file) => file.category === id);
      return { id, label: BACKUP_CATEGORY_LABELS[id], fileCount: files.length, sizeBytes: files.reduce((sum, file) => sum + file.size, 0) };
    }),
    fileCount: bundle.files.length,
    sizeBytes: bundle.files.reduce((sum, file) => sum + file.size, 0),
  };
}

export class BackupManager {
  constructor(private readonly userData: string, private readonly appVersion: string) {}

  get backupsDir(): string { return path.join(this.userData, "backups"); }
  private get configPath(): string { return path.join(this.userData, "backup-settings.json"); }

  getConfig(): BackupConfig {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Partial<BackupConfig>;
      return { autoEnabled: parsed.autoEnabled === true, retentionDays: parsed.retentionDays === 30 ? 30 : 7, lastAutoBackupAt: typeof parsed.lastAutoBackupAt === "string" ? parsed.lastAutoBackupAt : undefined };
    } catch { return { ...DEFAULT_CONFIG }; }
  }

  saveConfig(patch: Partial<BackupConfig>): BackupConfig {
    const before = this.getConfig();
    const config: BackupConfig = { ...before, autoEnabled: patch.autoEnabled ?? before.autoEnabled, retentionDays: patch.retentionDays === 30 ? 30 : patch.retentionDays === 7 ? 7 : before.retentionDays };
    atomicWrite(this.configPath, JSON.stringify(config, null, 2));
    return config;
  }

  create(filePath: string, requested: unknown): BackupSummary {
    const categories = Array.isArray(requested) ? requested.filter(isBackupCategory) : ALL_CATEGORIES;
    if (!categories.length) throw new Error("請至少選擇一種資料");
    const seen = new Set<string>();
    const files: BackupFile[] = [];
    for (const category of categories) {
      for (const entry of CATEGORY_PATHS[category]) {
        for (const relative of listFiles(this.userData, entry)) {
          if (seen.has(relative)) continue;
          seen.add(relative);
          files.push(readBackupFile(this.userData, relative, category));
          if (files.length > MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_UNCOMPRESSED_BYTES) throw new Error("備份內容超過 512 MB 安全限制");
        }
      }
    }
    const bundle: BackupBundle = { format: "cyrene-backup", version: 1, createdAt: new Date().toISOString(), appVersion: this.appVersion, categories, files };
    atomicWrite(filePath, zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 }));
    return summarize(bundle, filePath);
  }

  inspect(filePath: string): BackupSummary { return summarize(parseBundle(filePath), filePath); }

  restore(filePath: string, requested: unknown): { restoredFiles: number; safetyBackupPath: string } {
    const bundle = parseBundle(filePath);
    const categories = Array.isArray(requested) ? requested.filter(isBackupCategory) : bundle.categories;
    if (!categories.length) throw new Error("請至少選擇一種要還原的資料");
    const safetyBackupPath = path.join(this.backupsDir, `還原前-${new Date().toISOString().replace(/[:.]/g, "-")}.cybackup`);
    this.create(safetyBackupPath, categories);
    let restoredFiles = 0;
    for (const file of bundle.files) {
      if (!categories.includes(file.category)) continue;
      const relative = safeRelativePath(file.path);
      const destination = path.resolve(this.userData, relative);
      if (!destination.startsWith(path.resolve(this.userData) + path.sep)) throw new Error("還原路徑超出資料目錄");
      let restored = Buffer.from(file.data, "base64");
      if (file.category === "settings" && file.path.endsWith(".json") && fs.existsSync(destination)) {
        try {
          const incoming = JSON.parse(restored.toString("utf8"));
          const current = JSON.parse(fs.readFileSync(destination, "utf8"));
          restored = Buffer.from(JSON.stringify(preserveCurrentSecrets(incoming, current), null, 2), "utf8");
        } catch { /* restore original bytes if either file is malformed */ }
      }
      atomicWrite(destination, restored);
      restoredFiles += 1;
    }
    return { restoredFiles, safetyBackupPath };
  }

  runAutoBackupIfDue(): BackupSummary | null {
    const config = this.getConfig();
    if (!config.autoEnabled) return null;
    const last = config.lastAutoBackupAt ? Date.parse(config.lastAutoBackupAt) : 0;
    if (Date.now() - last < 20 * 60 * 60 * 1000) return null;
    const createdAt = new Date();
    const filePath = path.join(this.backupsDir, `自動-${createdAt.toISOString().slice(0, 10)}.cybackup`);
    const summary = this.create(filePath, ["conversations", "memories", "planning", "personalization", "settings"]);
    const next = { ...config, lastAutoBackupAt: createdAt.toISOString() };
    atomicWrite(this.configPath, JSON.stringify(next, null, 2));
    this.prune(config.retentionDays);
    return summary;
  }

  private prune(retentionDays: number): void {
    if (!fs.existsSync(this.backupsDir)) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const name of fs.readdirSync(this.backupsDir)) {
      if (!name.startsWith("自動-") || !name.endsWith(".cybackup")) continue;
      const file = path.join(this.backupsDir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* best effort */ }
    }
  }
}
