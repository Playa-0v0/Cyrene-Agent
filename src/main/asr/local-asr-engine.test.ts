import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalAsrStream,
  DEFAULT_LOCAL_ASR_URL,
} from "./local-asr-engine";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(probeStatus: number, transcribeStatus: number, body: unknown) {
  const impl = async (url: string | URL | Request) => {
    if (String(url).includes("/status")) {
      if (probeStatus === 503) {
        // 服务在跑但模型未就绪：真实 503 响应（body 仍是完整 JSON）
        return new Response(JSON.stringify({ model_loaded: false, ready: false }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (probeStatus >= 500) {
        // 模拟服务未启动：连接失败（fetch reject）
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ model_loaded: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: transcribeStatus,
      headers: { "Content-Type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("LocalAsrStream", () => {
  it("probes /status on start and transcribes captured frames as one WAV", async () => {
    stubFetch(200, 200, { text: "本地转写结果" });

    const finals: string[] = [];
    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, (t) => finals.push(t));

    await expect(stream.start()).resolves.toBeUndefined();
    stream.sendAudio(Buffer.from([0x34, 0x12]));
    stream.sendAudio(Buffer.from([0x78, 0x56]));

    await expect(stream.stop()).resolves.toBe("本地转写结果");
    expect(finals).toEqual(["本地转写结果"]);

    // 探测 + 转写各一次
    const fetches = vi.mocked(fetch).mock.calls;
    expect(fetches.some(([u]) => String(u).endsWith("/status"))).toBe(true);
    expect(fetches.some(([u]) => String(u).endsWith("/v1/audio/transcriptions"))).toBe(true);
  });

  it("throws a friendly error when the local service is not running", async () => {
    stubFetch(500, 200, null);

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await expect(stream.start()).rejects.toThrow("本地 ASR 服务未启动");
  });

  it("does not call the transcribe endpoint when the turn contains no audio", async () => {
    stubFetch(200, 200, { text: "x" });

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await stream.start();

    await expect(stream.stop()).resolves.toBe("");
    const fetches = vi.mocked(fetch).mock.calls;
    expect(fetches.some(([u]) => String(u).endsWith("/v1/audio/transcriptions"))).toBe(false);
  });

  it("surfaces HTTP errors from the transcribe endpoint", async () => {
    stubFetch(200, 500, null);

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));

    await expect(stream.stop()).rejects.toThrow("本地 ASR 转写失败 (HTTP 500)");
  });

  it("throws when the server response has no text field", async () => {
    stubFetch(200, 200, { result: "没有 text 字段" });

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));

    await expect(stream.stop()).rejects.toThrow("服务端未返回 text");
  });

  it("is idempotent: stop() uploads only once", async () => {
    stubFetch(200, 200, { text: "一次" });

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));

    await stream.stop();
    await stream.stop();

    const fetches = vi.mocked(fetch).mock.calls;
    const transcribes = fetches.filter(([u]) => String(u).endsWith("/v1/audio/transcriptions"));
    expect(transcribes).toHaveLength(1);
  });

  it("honors a custom baseUrl", async () => {
    stubFetch(200, 200, { text: "自定义" });

    const stream = new LocalAsrStream("http://127.0.0.1:9000", () => {});
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));
    await expect(stream.stop()).resolves.toBe("自定义");

    const fetches = vi.mocked(fetch).mock.calls;
    expect(fetches.some(([u]) => String(u).startsWith("http://127.0.0.1:9000/status"))).toBe(true);
  });

  it("strips trailing slashes from baseUrl before building request URLs", async () => {
    stubFetch(200, 200, { text: "斜杠" });

    const stream = new LocalAsrStream("http://127.0.0.1:8328/", () => {});
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));
    await expect(stream.stop()).resolves.toBe("斜杠");

    const fetches = vi.mocked(fetch).mock.calls;
    // 拼出来的路径不应出现双斜杠（//status / //v1/...）
    expect(fetches.some(([u]) => String(u).includes("//status"))).toBe(false);
    expect(fetches.some(([u]) => String(u).includes("//v1/audio/transcriptions"))).toBe(false);
    expect(fetches.some(([u]) => String(u).endsWith("8328/v1/audio/transcriptions"))).toBe(true);
  });

  it("reports 'model loading' (not 'service not running') when /status returns 503", async () => {
    stubFetch(503, 200, null);

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await expect(stream.start()).rejects.toThrow("模型加载中");
  });

  it("sends Authorization header when a token is configured", async () => {
    stubFetch(200, 200, { text: "带令牌" });

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {}, "s3cret");
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));
    await expect(stream.stop()).resolves.toBe("带令牌");

    const transcribe = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u).endsWith("/v1/audio/transcriptions"));
    expect(transcribe).toBeDefined();
    const init = transcribe?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer s3cret");
  });

  it("distinguishes transcribe timeout from service-not-running", async () => {
    // 转写请求超时：AbortSignal.timeout 触发 DOMException TimeoutError
    const impl = async (url: string | URL | Request) => {
      if (String(url).includes("/status")) {
        return new Response(JSON.stringify({ model_loaded: true }), { status: 200 });
      }
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    vi.stubGlobal("fetch", vi.fn(impl));

    const stream = new LocalAsrStream(DEFAULT_LOCAL_ASR_URL, () => {});
    await stream.start();
    stream.sendAudio(Buffer.from([1, 2]));

    await expect(stream.stop()).rejects.toThrow("转写超时");
  });
});
