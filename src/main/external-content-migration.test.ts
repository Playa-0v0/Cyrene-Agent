import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStagedExternalContent, type StagedContentMigrationInput } from "./external-content-migration";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-content-migration-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  input: StagedContentMigrationInput;
  installRoot: string;
  userData: string;
  staging: string;
  userPrompts: string;
  userSkills: string;
  manifestFile: string;
}

/** install 目录 + userData + 暂存目录 三层结构的测试夹具。 */
function createFixture(): Fixture {
  const root = temporaryDirectory();
  const installRoot = path.join(root, "Cyrene");
  const userData = path.join(root, "user-data");
  const staging = path.join(root, ".Cyrene.content-preserve");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  return {
    installRoot,
    userData,
    staging,
    userPrompts: path.join(userData, "prompts"),
    userSkills: path.join(userData, "skills"),
    manifestFile: path.join(userData, "content-manifest.json"),
    input: {
      isPackaged: true,
      installRoot,
      promptDirectories: [path.join(userData, "prompts"), path.join(installRoot, "prompts")],
      userSkillDirectories: [path.join(userData, "skills")],
    },
  };
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe("migrateStagedExternalContent", () => {
  it("migrates user-modified files and discards pristine shipped files", () => {
    const f = createFixture();
    const shipped = path.join(f.installRoot, "prompts");
    write(path.join(shipped, "soul.md"), "new shipped soul"); // 新版内置（安装器刷新）
    write(path.join(shipped, "tone.md"), "new shipped tone");

    // 上次启动时记录的官方内置：soul 是旧内置内容，tone 已被用户改过
    write(f.manifestFile, JSON.stringify({
      prompts: { "soul.md": sha1Of("old shipped soul"), "tone.md": sha1Of("old shipped tone") },
      skills: {},
    }));

    // 暂存目录：升级前从安装目录搬出来的内容
    write(path.join(f.staging, "prompts", "soul.md"), "old shipped soul"); // 未改过
    write(path.join(f.staging, "prompts", "tone.md"), "user edited tone"); // 用户改过
    write(path.join(f.staging, "prompts", "user-extra.md"), "user added"); // 用户新增

    migrateStagedExternalContent(f.input);

    expect(fs.existsSync(path.join(f.userPrompts, "soul.md"))).toBe(false); // 内置 → 丢弃
    expect(fs.readFileSync(path.join(f.userPrompts, "tone.md"), "utf8")).toBe("user edited tone");
    expect(fs.readFileSync(path.join(f.userPrompts, "user-extra.md"), "utf8")).toBe("user added");
    expect(fs.existsSync(f.staging)).toBe(false); // 暂存目录已清理
  });

  it("without a manifest only recovers files missing from the new shipped content", () => {
    const f = createFixture();
    write(path.join(f.installRoot, "prompts", "soul.md"), "new shipped soul");
    // 无 manifest：soul 与新版内置相同 → 丢弃；skill-notes.md 新版没有 → 恢复
    write(path.join(f.staging, "prompts", "soul.md"), "new shipped soul");
    write(path.join(f.staging, "prompts", "skill-notes.md"), "old removed shipped");

    migrateStagedExternalContent(f.input);

    expect(fs.existsSync(path.join(f.userPrompts, "soul.md"))).toBe(false);
    expect(fs.readFileSync(path.join(f.userPrompts, "skill-notes.md"), "utf8")).toBe("old removed shipped");
  });

  it("never overwrites existing user files and preserves nested skill structure", () => {
    const f = createFixture();
    write(path.join(f.staging, "skills", "my-skill", "SKILL.md"), "staged");
    write(path.join(f.staging, "skills", "my-skill", "assets", "icon.png"), "binary-ish");
    write(path.join(f.userSkills, "my-skill", "SKILL.md"), "user current"); // 用户已有（合并幂等）

    migrateStagedExternalContent(f.input);

    expect(fs.readFileSync(path.join(f.userSkills, "my-skill", "SKILL.md"), "utf8")).toBe("user current");
    expect(fs.readFileSync(path.join(f.userSkills, "my-skill", "assets", "icon.png"), "utf8")).toBe("binary-ish");
  });

  it("writes a manifest of current shipped content for the next upgrade", () => {
    const f = createFixture();
    write(path.join(f.installRoot, "prompts", "soul.md"), "shipped v1");
    write(path.join(f.installRoot, "skills", "demo", "SKILL.md"), "shipped skill");

    migrateStagedExternalContent(f.input);

    const manifest = JSON.parse(fs.readFileSync(f.manifestFile, "utf8"));
    expect(manifest.prompts["soul.md"]).toBe(sha1Of("shipped v1"));
    expect(manifest.skills["demo/SKILL.md"]).toBe(sha1Of("shipped skill"));
  });

  it("does nothing in development builds", () => {
    const f = createFixture();
    write(path.join(f.staging, "prompts", "soul.md"), "staged");

    migrateStagedExternalContent({ ...f.input, isPackaged: false });

    expect(fs.existsSync(f.staging)).toBe(true);
    expect(fs.existsSync(f.manifestFile)).toBe(false);
  });
});

function sha1Of(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}
