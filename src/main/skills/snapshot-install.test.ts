import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import { installSkillsSnapshot, SNAPSHOT_SENTINEL, snapshotSentinelPath } from "./snapshot-install";

/** 用内存目录模拟 fs，方便断言哨兵/解压行为。 */
function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    existsSync: (p: string) => files.has(path.normalize(p)),
    mkdirSync: vi.fn((_p: string) => undefined),
    writeFileSync: vi.fn((p: string, c: string) => {
      files.set(path.normalize(p), c);
    }),
    readdirSync: (p: string) => {
      const prefix = path.normalize(p) + path.sep;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rel = key.slice(prefix.length);
          const first = rel.split(path.sep)[0];
          if (first) names.add(first);
        }
      }
      return [...names];
    },
  };
}

describe("installSkillsSnapshot", () => {
  const archive = "C:\\vendor\\cyrene-skills\\skills-snapshot.zip";
  const userDir = "C:\\userData\\skills";

  it("归档不存在 → no_archive，不碰目标目录", async () => {
    const fsMock = makeFs();
    const status = await installSkillsSnapshot({
      archivePath: null,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
    });
    expect(status).toBe("no_archive");
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
  });

  it("归档缺失文件时按不存在处理（existsSync 返回 false）", async () => {
    const fsMock = makeFs();
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: () => false,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
    });
    expect(status).toBe("no_archive");
  });

  it("哨兵已存在 → skipped_sentinel，不重复解压", async () => {
    const fsMock = makeFs({ [archive]: "zip", [snapshotSentinelPath(userDir)]: "2026-01-01" });
    const extract = vi.fn(async () => undefined);
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      extract,
    });
    expect(status).toBe("skipped_sentinel");
    expect(extract).not.toHaveBeenCalled();
  });

  it("目标目录已有用户内容 → skipped_existing，写哨兵但不覆盖", async () => {
    const fsMock = makeFs({ [archive]: "zip", [path.join(userDir, "my-skill", "SKILL.md")]: "# mine" });
    const extract = vi.fn(async () => undefined);
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      extract,
    });
    expect(status).toBe("skipped_existing");
    expect(extract).not.toHaveBeenCalled();
    expect(fsMock.files.has(snapshotSentinelPath(userDir))).toBe(true);
  });

  it("首装成功 → installed，解压并写哨兵", async () => {
    const fsMock = makeFs({ [archive]: "zip" });
    const extract = vi.fn(async () => undefined);
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      extract,
    });
    expect(status).toBe("installed");
    expect(extract).toHaveBeenCalledWith(archive, { dir: userDir });
    expect(fsMock.files.has(snapshotSentinelPath(userDir))).toBe(true);
  });

  it("解压异常 → failed，不写哨兵（下次启动重试）", async () => {
    const fsMock = makeFs({ [archive]: "zip" });
    const extract = vi.fn(async () => {
      throw new Error("corrupt zip");
    });
    const status = await installSkillsSnapshot({
      archivePath: archive,
      userSkillsDir: userDir,
      existsSync: fsMock.existsSync,
      mkdirSync: fsMock.mkdirSync,
      writeFileSync: fsMock.writeFileSync,
      readdirSync: fsMock.readdirSync,
      extract,
    });
    expect(status).toBe("failed");
    expect(fsMock.files.has(snapshotSentinelPath(userDir))).toBe(false);
  });

  it("哨兵文件名常量暴露给调用方", () => {
    expect(SNAPSHOT_SENTINEL).toBe(".snapshot-installed");
  });
});
