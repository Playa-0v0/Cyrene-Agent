import { describe, expect, it, vi } from "vitest";
import { consumeMosslandSse } from "./mossland-stream";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

describe("consumeMosslandSse", () => {
  it("handles chunk boundaries, optional task.created, empty deltas, and the explicit done event", async () => {
    const onAudio = vi.fn();
    const response = sseResponse([
      'data: {"type":"task.created","task_id":"task-1","object":"audio.speech","status":"PROCESSING","model":"moss-tts-1.5-flash"}\r\n\r\n',
      'data: {"type":"speech.created","format":"pcm","sample_rate":48000,',
      '"channels":1,"bit_depth":16}\n\n',
      'data: {"type":"speech.audio.delta","audio":""}\n\n',
      `data: ${JSON.stringify({ type: "speech.audio.delta", audio: Buffer.from("pcm-audio").toString("base64") })}\n\n`,
      'data: {"type":"speech.audio.done"}\n\n',
    ]);

    const result = await consumeMosslandSse(response, { onAudio });

    expect(result).toEqual({
      taskId: "task-1",
      format: "pcm",
      sampleRate: 48_000,
      channels: 1,
      bitDepth: 16,
    });
    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onAudio.mock.calls[0]?.[0]).toEqual(Buffer.from("pcm-audio"));
  });

  it("allows speech.created to be the first event", async () => {
    const response = sseResponse([
      'data: {"type":"speech.created","format":"pcm","sample_rate":24000,"channels":1,"bit_depth":16}\n\n',
      'data: {"type":"speech.audio.done"}\n\n',
    ]);

    await expect(consumeMosslandSse(response)).resolves.toMatchObject({ sampleRate: 24_000 });
  });

  it("surfaces an error terminal event", async () => {
    const response = sseResponse([
      'data: {"type":"error","error":{"code":"upstream_failed","message":"生成失败"}}\n\n',
    ]);

    await expect(consumeMosslandSse(response)).rejects.toThrow("生成失败（upstream_failed）");
  });

  it("does not treat EOF before speech.audio.done as success", async () => {
    const response = sseResponse([
      'data: {"type":"speech.created","format":"pcm","sample_rate":48000,"channels":1,"bit_depth":16}\n\n',
      `data: ${JSON.stringify({ type: "speech.audio.delta", audio: "AA==" })}\n\n`,
    ]);

    await expect(consumeMosslandSse(response)).rejects.toThrow("连接提前结束");
  });

  it("rejects a malformed base64 audio delta", async () => {
    const response = sseResponse([
      'data: {"type":"speech.created","format":"pcm","sample_rate":48000,"channels":1,"bit_depth":16}\n\n',
      'data: {"type":"speech.audio.delta","audio":"not base64!"}\n\n',
    ]);

    await expect(consumeMosslandSse(response)).rejects.toThrow("Base64");
  });

  it.each([
    ['{"type":"speech.created","format":"wav","sample_rate":48000,"channels":1,"bit_depth":16}', "format"],
    ['{"type":"speech.created","format":"pcm","sample_rate":0,"channels":1,"bit_depth":16}', "sample_rate"],
    ['{"type":"speech.created","format":"pcm","sample_rate":48000,"channels":0,"bit_depth":16}', "channels"],
    ['{"type":"speech.created","format":"pcm","sample_rate":48000,"channels":1,"bit_depth":12}', "bit_depth"],
  ])("rejects invalid PCM metadata: %s", async (created, field) => {
    const response = sseResponse([`data: ${created}\n\n`]);
    await expect(consumeMosslandSse(response)).rejects.toThrow(field);
  });
});
