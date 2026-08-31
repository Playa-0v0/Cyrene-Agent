import { describe, expect, it } from "vitest";
import { ChatTimeStreamPrefixFilter } from "./chat-time-stream-filter";

function consume(filter: ChatTimeStreamPrefixFilter, chunks: string[]): string {
  return chunks.map((chunk) => filter.push(chunk)).join("") + filter.finish();
}

describe("ChatTimeStreamPrefixFilter", () => {
  it("removes only a complete leading time metadata prefix split across chunks", () => {
    const filter = new ChatTimeStreamPrefixFilter();

    expect(filter.push("[2026-08")).toBe("");
    expect(filter.push("-02 04:32, Asia/Shanghai]\n你好呀")).toBe("你好呀");
    expect(filter.finish()).toBe("");
  });

  it("passes ordinary replies through without waiting", () => {
    expect(consume(new ChatTimeStreamPrefixFilter(), ["你好，", "有什么想聊的吗？"])).toBe("你好，有什么想聊的吗？");
  });

  it("releases normal bracket content verbatim as soon as it no longer matches", () => {
    expect(consume(new ChatTimeStreamPrefixFilter(), ["[重要]", " 这段内容不能删"])).toBe("[重要] 这段内容不能删");
  });

  it("releases a timestamp-like but invalid prefix verbatim", () => {
    expect(consume(new ChatTimeStreamPrefixFilter(), ["[2026-08-02 04:32, ", "not a timezone]正文"])).toBe(
      "[2026-08-02 04:32, not a timezone]正文",
    );
  });

  it("removes repeated leading timestamp metadata before releasing visible text", () => {
    expect(consume(new ChatTimeStreamPrefixFilter(), [
      "[2026-08-10 18:18, Asia/Shanghai]\n",
      "[2026-08-10 18:18, Asia/Shanghai]你好",
    ])).toBe("你好");
  });

  it("flushes an unfinished probe when the stream ends", () => {
    expect(consume(new ChatTimeStreamPrefixFilter(), ["[2026-08-"])).toBe("[2026-08-");
  });
});
