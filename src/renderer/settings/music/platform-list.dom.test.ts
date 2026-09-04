// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function musicPlatformNames(): string[] {
  const html = readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  return Array.from(page.querySelectorAll("#music-platform-list > .plugin-card h2"), (node) =>
    node.textContent?.trim() ?? "",
  );
}

describe("音乐工具入口", () => {
  it("只展示已经支持的网易云音乐和本地音乐", () => {
    expect(musicPlatformNames()).toEqual(["网易云音乐", "本地音乐"]);
  });
});
