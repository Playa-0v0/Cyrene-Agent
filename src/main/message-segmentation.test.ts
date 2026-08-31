import { describe, expect, it } from "vitest";
import { splitTextBySentenceBreaks } from "../shared/message-segmentation";

describe("shared message segmentation", () => {
  it("splits text by sentence-ending punctuation and trims new segment leading whitespace", () => {
    const text = [
      "淄博今天有小雨，出门记得带伞哦，别淋湿啦。",
      "中午吃的什么呀？最近有什么好玩的事想分享吗？",
      "开发辛苦了，记得多起来动一动，别一直坐着。",
    ].join("\n");

    expect(splitTextBySentenceBreaks(text)).toEqual([
      "淄博今天有小雨，出门记得带伞哦，别淋湿啦。",
      "中午吃的什么呀？",
      "最近有什么好玩的事想分享吗？",
      "开发辛苦了，记得多起来动一动，别一直坐着。",
    ]);
  });

  it("keeps the tail merged into the last part when the max part count is reached", () => {
    const text = "一。二。三。四。五。";

    expect(splitTextBySentenceBreaks(text, 3)).toEqual([
      "一。",
      "二。",
      "三。四。五。",
    ]);
  });
});
