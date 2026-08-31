import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsPlaybackRequest } from "./tts-playback";

// 模拟 HTMLAudioElement：记录实例并允许手动触发 onended 完成播放
class MockAudio {
  static instances: MockAudio[] = [];
  currentTime = 0;
  duration = 1;
  preload = "none";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  private srcValue = "";
  get src(): string {
    return this.srcValue;
  }
  set src(value: string) {
    this.srcValue = value;
  }
  constructor(_src?: string) {
    MockAudio.instances.push(this);
  }
}

let ttsModule: typeof import("./tts-playback");
let startSessionMock: ReturnType<typeof vi.fn>;
let onCacheKeySpy: ReturnType<typeof vi.fn>;

async function loadModule(): Promise<void> {
  vi.resetModules();
  vi.stubGlobal("window", {
    tts: {
      startSession: startSessionMock,
      cancelSession: vi.fn(async () => true),
      onSessionEvent: vi.fn(() => () => undefined),
    },
    live2dSpeech: {
      prepare: vi.fn(),
      startMouth: vi.fn(),
      stopMouth: vi.fn(),
    },
  });
  vi.stubGlobal("Audio", MockAudio);
  // 保留全局 URL 构造器，仅补充浏览器独有的 createObjectURL/revokeObjectURL
  Object.assign(globalThis.URL, {
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("MediaSource", undefined);
  ttsModule = await import("./tts-playback");
}

// 等待当前段合成出 audio 实例并触发播放完成
async function completeSegment(index: number): Promise<void> {
  await vi.waitFor(() => {
    expect(MockAudio.instances.length).toBeGreaterThanOrEqual(index + 1);
  });
  MockAudio.instances[index].onended?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function segmentedRequest(overrides: Partial<TtsPlaybackRequest> = {}): TtsPlaybackRequest {
  return {
    conversationId: "c1",
    messageId: "m1",
    text: "第一句。第二句。第三句。",
    segmented: true,
    segmentationGranularity: "sentence",
    ...overrides,
  };
}

describe("manual segmented TTS playback", () => {
  beforeEach(async () => {
    MockAudio.instances = [];
    startSessionMock = vi.fn(async (request: { requestId: string; speechText: string }) => ({
      requestId: request.requestId,
      status: "ready",
      base64: "QUFBQQ==",
      cacheKey: `key-${request.speechText}`,
      format: "mp3",
      cached: false,
    }));
    onCacheKeySpy = vi.fn();
    await loadModule();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each segment with bypassMessageCache and never writes back the original message cache", async () => {
    await ttsModule.toggleTtsPlayback(segmentedRequest({ onCacheKey: onCacheKeySpy }));
    await completeSegment(0);
    await completeSegment(1);
    await completeSegment(2);
    await vi.waitFor(() => {
      expect(ttsModule.getTtsPlaybackSnapshot()).toMatchObject({ messageId: "m1", status: "completed" });
    });

    // 三段请求全部携带跳过消息级缓存的标志
    expect(startSessionMock).toHaveBeenCalledTimes(3);
    for (const call of startSessionMock.mock.calls) {
      expect(call[0]).toMatchObject({ bypassMessageCache: true });
    }
    // 分段子请求不会把缓存写回原消息
    expect(onCacheKeySpy).not.toHaveBeenCalled();
  });

  it("re-reads the whole segmented queue from the first segment when replaying after completion", async () => {
    const request = segmentedRequest();
    await ttsModule.toggleTtsPlayback(request);
    await completeSegment(0);
    await completeSegment(1);
    await completeSegment(2);
    await vi.waitFor(() => {
      expect(ttsModule.getTtsPlaybackSnapshot()).toMatchObject({ status: "completed" });
    });

    // 清空实例追踪：第二次点击应重建完整队列而不是重播最后一段
    MockAudio.instances = [];
    await ttsModule.toggleTtsPlayback(request);
    await completeSegment(0);
    await completeSegment(1);
    await completeSegment(2);
    await vi.waitFor(() => {
      expect(ttsModule.getTtsPlaybackSnapshot()).toMatchObject({ status: "completed" });
    });

    expect(startSessionMock).toHaveBeenCalledTimes(6);
    const speechTexts = startSessionMock.mock.calls.map((call) => call[0].speechText);
    // 第二轮与第一轮的段顺序一致：从第一段开始完整重播
    expect(speechTexts.slice(0, 3)).toEqual(speechTexts.slice(3, 6));
    expect(speechTexts.slice(3, 6)).not.toEqual([speechTexts[2]]);
  });

  it("keeps replaying the same audio element for non-segmented completion", async () => {
    const request: TtsPlaybackRequest = {
      conversationId: "c1",
      messageId: "m1",
      text: "这是一句完整的话。",
      segmented: false,
    };
    await ttsModule.toggleTtsPlayback(request);
    await vi.waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));
    await completeSegment(0);
    await vi.waitFor(() => {
      expect(ttsModule.getTtsPlaybackSnapshot()).toMatchObject({ status: "completed" });
    });

    const playCallsBefore = MockAudio.instances[0].play.mock.calls.length;
    await ttsModule.toggleTtsPlayback(request);
    // 非分段完成后再点：不新建会话，直接重播同一 Audio 元素
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(MockAudio.instances[0].play.mock.calls.length).toBeGreaterThan(playCallsBefore);
  });
});
