import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

function posOf(marker: string): number {
  const index = html.indexOf(marker);
  if (index < 0) throw new Error(`markup 缺少锚点: ${marker}`);
  return index;
}

describe("TTS settings 面板结构（自动朗读文本切分）", () => {
  it("开关标题已改名且不再残留「早播」字样", () => {
    expect(html).toContain("<strong>自动朗读文本切分</strong>");
    expect(html).not.toContain("早播文本切分");
  });

  it("开关与下拉的稳定 id 仍然存在", () => {
    expect(html).toContain('id="tts-early-read-split-enabled"');
    expect(html).toContain('id="tts-early-read-split-mode"');
  });

  it("行文顺序为：自动朗读回复 < 切分开关 < 切分模式 < 语速 < 音量", () => {
    const markers = [
      'id="tts-auto-read"',
      "<strong>自动朗读文本切分</strong>",
      'id="tts-early-read-split-mode"',
      'id="tts-speed"',
      'id="tts-volume"',
    ];
    const positions = markers.map((marker) => posOf(marker));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("切分下拉包含一句一切/一段一切两个稳定选项", () => {
    expect(html).toContain('<option value="sentence">一句一切</option>');
    expect(html).toContain('<option value="paragraph">一段一切</option>');
  });
});
