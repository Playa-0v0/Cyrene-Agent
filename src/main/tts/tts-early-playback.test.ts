import { describe, expect, it } from "vitest"
import { canUseMinimaxStreamingEarly, extractEarlyTtsSegment } from "../../shared/tts-early-playback"

describe("tts early playback guards", () => {
  it("only enables early playback for minimax with auto read and streaming", () => {
    const base = {
      ttsEngine: "minimax",
      ttsAutoRead: true,
      ttsStreaming: true,
      ttsMinimaxKey: "key",
      ttsMinimaxVoiceId: "voice",
    }

    expect(canUseMinimaxStreamingEarly(base)).toBe(true)
    expect(canUseMinimaxStreamingEarly({ ...base, ttsStreaming: false })).toBe(false)
    expect(canUseMinimaxStreamingEarly({ ...base, ttsEngine: "gptsovits" })).toBe(false)
    expect(canUseMinimaxStreamingEarly({ ...base, ttsEngine: "custom-cloud" })).toBe(false)
    expect(canUseMinimaxStreamingEarly({ ...base, ttsMinimaxKey: "" })).toBe(false)
  })

  it("extracts the first complete sentence only after a useful minimum length", () => {
    expect(extractEarlyTtsSegment("好。後面還有內容。")).toBeNull()
    expect(extractEarlyTtsSegment("今天辛苦啦，我們慢慢來。後面還有內容。")).toEqual({
      segment: "今天辛苦啦，我們慢慢來。",
      remainder: "後面還有內容。",
    })
  })
})
