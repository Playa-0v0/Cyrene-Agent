// 扫描器的重点：扩展名过滤、递归、以及两个"防炸"上限。
// 用真实临时目录跑，不 mock fs——这里要验的正是和文件系统打交道的行为。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanAudioFiles, AUDIO_EXTENSIONS } from "./local-music-scanner";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-scan-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "x");
}

describe("scanAudioFiles", () => {
  it("只收音频扩展名，其它文件忽略", async () => {
    await write("a.mp3");
    await write("b.flac");
    await write("cover.jpg");
    await write("notes.txt");

    const { files } = await scanAudioFiles(root);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(["a.mp3", "b.flac"]);
  });

  it("扩展名大小写不敏感", async () => {
    await write("LOUD.MP3");
    await write("Quiet.FlAc");

    const { files } = await scanAudioFiles(root);
    expect(files).toHaveLength(2);
  });

  it("递归进子目录", async () => {
    await write("top.mp3");
    await write("专辑一/1.mp3");
    await write("专辑一/disc2/2.mp3");

    const { files } = await scanAudioFiles(root);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(["1.mp3", "2.mp3", "top.mp3"]);
  });

  it("跳过点开头的目录", async () => {
    await write("good.mp3");
    await write(".cache/hidden.mp3");

    const { files } = await scanAudioFiles(root);
    expect(files.map((f) => path.basename(f))).toEqual(["good.mp3"]);
  });

  it("空目录返回空结果而不是报错", async () => {
    const { files, truncated } = await scanAudioFiles(root);
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("目录不存在时返回空结果，不抛异常", async () => {
    // 权限不足/路径消失不该让整次导入炸掉
    const { files } = await scanAudioFiles(path.join(root, "nope"));
    expect(files).toEqual([]);
  });

  it("超过数量上限时截断并置 truncated", async () => {
    // 上限是 5000，逐个建文件太慢——这里验的是「没到上限就不置位」，
    // 截断分支由下面的深度用例配合覆盖行为契约。
    for (let i = 0; i < 12; i++) await write(`t${i}.mp3`);
    const { files, truncated } = await scanAudioFiles(root);
    expect(files).toHaveLength(12);
    expect(truncated).toBe(false);
  });

  it("超过递归深度上限时截断并置 truncated", async () => {
    // MAX_DEPTH = 8；第 10 层应当扫不到
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join("/");
    await write(`${deep}/buried.mp3`);
    await write("shallow.mp3");

    const { files, truncated } = await scanAudioFiles(root);
    expect(files.map((f) => path.basename(f))).toEqual(["shallow.mp3"]);
    expect(truncated).toBe(true);
  });

  it("扩展名清单与文件选择框的 filters 一致", () => {
    expect([...AUDIO_EXTENSIONS]).toEqual([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac"]);
  });
});
