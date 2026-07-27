import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { BackupManager } from "./backup-manager";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-backup-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("BackupManager", () => {
  it("creates, inspects, and selectively restores a portable backup", () => {
    const userData = tempDir();
    fs.mkdirSync(path.join(userData, "cyrene-chats"));
    fs.writeFileSync(path.join(userData, "cyrene-chats", "one.json"), "first");
    fs.writeFileSync(path.join(userData, "memory.json"), "memory-one");
    const backup = path.join(tempDir(), "test.cybackup");
    const manager = new BackupManager(userData, "1.2.3");

    const created = manager.create(backup, ["conversations", "memories"]);
    expect(created.fileCount).toBe(2);
    expect(manager.inspect(backup).appVersion).toBe("1.2.3");

    fs.writeFileSync(path.join(userData, "cyrene-chats", "one.json"), "changed");
    fs.writeFileSync(path.join(userData, "memory.json"), "memory-changed");
    const restored = manager.restore(backup, ["conversations"]);
    expect(restored.restoredFiles).toBe(1);
    expect(fs.readFileSync(path.join(userData, "cyrene-chats", "one.json"), "utf8")).toBe("first");
    expect(fs.readFileSync(path.join(userData, "memory.json"), "utf8")).toBe("memory-changed");
    expect(fs.existsSync(restored.safetyBackupPath)).toBe(true);
  });

  it("removes credentials from settings backups without erasing current keys on restore", () => {
    const userData = tempDir();
    const settingsPath = path.join(userData, "model-settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ apiKey: "original", model: "old" }));
    const backup = path.join(tempDir(), "settings.cybackup");
    const manager = new BackupManager(userData, "1.0.0");
    manager.create(backup, ["settings"]);

    fs.writeFileSync(settingsPath, JSON.stringify({ apiKey: "current-secret", model: "new" }));
    manager.restore(backup, ["settings"]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({ apiKey: "current-secret", model: "old" });
  });
});
