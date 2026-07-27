import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordDiscordMusicInNotebook,
  recordDiscordToolActionsInNotebook,
  selectDiscordNotebookAction,
} from "./notebook-activity";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function notebookFile(initial = "# 共同筆記\n\n原本的內容\n"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-discord-notes-"));
  tempDirs.push(dir);
  const file = path.join(dir, "我們共同的筆記本.md");
  await fs.writeFile(file, initial, "utf8");
  return file;
}

describe("Discord notebook activity", () => {
  it("groups songs into a dated Discord memory section", async () => {
    const file = await notebookFile();
    const common = {
      companionName: "Clark",
      occurredAt: new Date("2026-07-22T12:34:00.000Z"),
    };
    await recordDiscordMusicInNotebook({ ...common, title: "Song One", url: "https://example.com/one" }, file);
    await recordDiscordMusicInNotebook({ ...common, title: "Song Two", url: "https://example.com/two", playlistTitle: "夜晚歌單" }, file);

    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("### ✦ 2026年7月22日 · Discord 共同足跡");
    expect(content).toContain("**晚上 · 一起聽歌**，和 夥伴");
    expect(content).not.toContain("Clark");
    expect(content).toContain("[Song One](https://example.com/one)");
    expect(content).toContain("[Song Two](https://example.com/two)");
    expect(content).not.toContain("音樂房");
    expect(content).not.toContain("夥伴的伺服器");
    expect(content.match(/Discord 共同足跡/g)).toHaveLength(1);
    expect(content).toContain("原本的內容");
  });

  it("does not duplicate the same song on the same day", async () => {
    const file = await notebookFile();
    const entry = {
      title: "Repeat Song",
      url: "https://example.com/repeat",
      occurredAt: new Date("2026-07-22T02:00:00.000Z"),
    };
    await recordDiscordMusicInNotebook(entry, file);
    await recordDiscordMusicInNotebook(entry, file);

    const content = await fs.readFile(file, "utf8");
    expect(content.match(/\[Repeat Song\]/g)).toHaveLength(1);
  });

  it("keeps only completed actions and ignores informational tools", () => {
    expect(selectDiscordNotebookAction({ toolId: "weather", args: { city: "台北" }, output: "晴天" })).toBeNull();
    expect(selectDiscordNotebookAction({ toolId: "web_search", args: { query: "現在幾點" }, output: "結果" })).toBeNull();
    expect(selectDiscordNotebookAction({ toolId: "todo_write", args: { todos: [] }, output: "已規劃" })).toBeNull();
    expect(selectDiscordNotebookAction({ toolId: "write_pdf", args: { outputPath: "/tmp/report.pdf" }, output: "[錯誤] failed" })).toBeNull();
    expect(selectDiscordNotebookAction({ toolId: "write_pdf", args: { outputPath: "/tmp/report.pdf" }, output: "完成" }))
      .toMatchObject({ label: "完成 PDF 文件", detail: "report.pdf" });
  });

  it("writes approved actions beside music in the same daily section", async () => {
    const file = await notebookFile();
    await recordDiscordToolActionsInNotebook([
      { toolId: "weather", args: { city: "台北" }, output: "晴天" },
      { toolId: "send_email", args: { subject: "週報" }, output: "[send_email] 已發送" },
    ], { companionName: "Clark", occurredAt: new Date("2026-07-22T13:00:00.000Z") }, file);

    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("**晚上 · 完成事項**，和 夥伴：寄出郵件「週報」");
    expect(content).not.toContain("台北");
  });

  it("keeps YuYing as the companion name", async () => {
    const file = await notebookFile();
    await recordDiscordMusicInNotebook({
      title: "Song",
      url: "https://example.com/song",
      companionName: "Yu_Ying",
      occurredAt: new Date("2026-07-22T02:00:00.000Z"),
    }, file);
    expect(await fs.readFile(file, "utf8")).toContain("**上午 · 一起聽歌**，和 YuYing");
  });
});
