import { describe, expect, it, vi } from "vitest";
import { EarlyTtsPlaybackQueue, StreamingMarkdownSegmenter } from "./early-tts-queue";

describe("StreamingMarkdownSegmenter", () => {
  it("emits each complete sentence once across token-like chunks", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("昔涟在这里")).toEqual([]);
    expect(segmenter.append("陪着你。下一句还")).toEqual(["昔涟在这里陪着你。"]);
    expect(segmenter.append("没有结束")).toEqual([]);
    expect(segmenter.append("呢！")).toEqual(["下一句还没有结束呢！"]);
    expect(segmenter.finish("昔涟在这里陪着你。下一句还没有结束呢！")).toEqual([]);
  });

  it("waits for fenced code blocks to close", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("这里有代码：\n```ts\nconst value = 1;\n")).toEqual([]);
    expect(segmenter.append("```\n\n然后继续。"))
      .toEqual(["这里有代码：\n```ts\nconst value = 1;\n```", "然后继续。"]);
  });

  it("waits for inline and block Latex delimiters to close", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("公式为 $\\frac{a")).toEqual([]);
    expect(segmenter.append("}{b}$。"))
      .toEqual(["公式为 $\\frac{a}{b}$。"]);

    const block = new StreamingMarkdownSegmenter();
    expect(block.append("$$\\int_0^1 x dx")).toEqual([]);
    expect(block.append("$$\n\n结论成立。"))
      .toEqual(["$$\\int_0^1 x dx$$", "结论成立。"]);
  });

  it("does not submit a GFM table until its block is closed", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("|姓名|分数|\n|-|-|\n|昔涟|100|\n")).toEqual([]);
    expect(segmenter.append("|伙伴|99|\n\n"))
      .toEqual(["|姓名|分数|\n|-|-|\n|昔涟|100|\n|伙伴|99|"]);
  });

  it("does not split on punctuation inside links or bare URLs", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    expect(segmenter.append("请打开 [有什么问题？](https://example.com/search?q=cyrene) 查看。"))
      .toEqual(["请打开 [有什么问题？](https://example.com/search?q=cyrene) 查看。"]);
    expect(segmenter.append("再看 https://example.com/search?q=tts&lang=zh。"))
      .toEqual(["再看 https://example.com/search?q=tts&lang=zh。"]);
  });

  it("flushes a closed final tail but not an unclosed structure", () => {
    const segmenter = new StreamingMarkdownSegmenter();
    segmenter.append("最后没有句号");
    expect(segmenter.finish("最后没有句号")).toEqual(["最后没有句号"]);

    const unclosed = new StreamingMarkdownSegmenter();
    unclosed.append("```ts\nconst value = 1");
    expect(unclosed.finish("```ts\nconst value = 1")).toEqual([]);
  });
});

describe("EarlyTtsPlaybackQueue", () => {
  it("plays queued sentences strictly one at a time", async () => {
    let finishFirst!: () => void;
    const first = new Promise<"completed">((resolve) => { finishFirst = () => resolve("completed"); });
    const play = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce("completed");
    const queue = new EarlyTtsPlaybackQueue(play);

    queue.append("第一句话完成了。第二句话也完成了。 ");
    await Promise.resolve();
    expect(play).toHaveBeenCalledTimes(1);
    finishFirst();
    await queue.finish("第一句话完成了。第二句话也完成了。 ");
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("cancels remaining segments when playback is interrupted", async () => {
    const play = vi.fn().mockResolvedValue("interrupted");
    const cancelPlayback = vi.fn();
    const queue = new EarlyTtsPlaybackQueue(play, cancelPlayback);
    queue.append("第一句话完成了。第二句话也完成了。 ");
    await queue.finish("第一句话完成了。第二句话也完成了。 ");
    expect(play).toHaveBeenCalledTimes(1);
    expect(queue.isCancelled()).toBe(true);
    queue.cancel();
    expect(cancelPlayback).toHaveBeenCalledOnce();
  });

  it("allows finish cleanup after an in-flight item is cancelled", async () => {
    let resolvePlayback!: () => void;
    const play = vi.fn(() => new Promise<"interrupted">((resolve) => {
      resolvePlayback = () => resolve("interrupted");
    }));
    const queue = new EarlyTtsPlaybackQueue(play);
    queue.append("正在播放的第一句话。后面还有一句话。 ");
    await Promise.resolve();
    queue.cancel();
    const finished = queue.finish("正在播放的第一句话。后面还有一句话。 ");
    resolvePlayback();
    await expect(finished).resolves.toBeUndefined();
    expect(play).toHaveBeenCalledTimes(1);
  });
});
