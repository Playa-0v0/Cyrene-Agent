import { describe, expect, it } from "vitest";
import { buildToolExecutionContext } from "./tool-execution-context";

describe("buildToolExecutionContext", () => {
  it("explicitly reports that no tool ran in the current turn", () => {
    const block = buildToolExecutionContext([]);

    expect(block).toContain("[TOOL_EXECUTION_CONTEXT]");
    expect(block).toContain('"calls":[]');
    expect(block).toContain("[/TOOL_EXECUTION_CONTEXT]");
  });

  it("preserves a successful structured tool result for Soul", () => {
    const block = buildToolExecutionContext([{
      toolId: "music_play_track",
      args: { candidateRef: "ctx_song_1" },
      output: JSON.stringify({ kind: "playback", dispatch: { state: "dispatched" } }),
      status: "succeeded",
    }]);

    expect(block).toContain('"toolId":"music_play_track"');
    expect(block).toContain('"status":"succeeded"');
    expect(block).toContain('"state":"dispatched"');
    expect(block).toContain("effect.state=dispatched");
    expect(block).toContain("terminal=true");
  });

  it("serializes terminal/retryable/deduplicated completion semantics", () => {
    const block = buildToolExecutionContext([{
      toolId: "music_play_track",
      args: { candidateRef: "ctx_song_1" },
      output: JSON.stringify({ kind: "playback", dispatch: { state: "dispatched" } }),
      status: "succeeded",
      terminal: true,
      retryable: false,
      deduplicated: true,
    }]);

    expect(block).toContain('"terminal":true');
    expect(block).toContain('"retryable":false');
    expect(block).toContain('"deduplicated":true');
    expect(block).toContain("不得重复执行相同 toolId");
    expect(block).toContain("deduplicated=true 表示本次调用未重新执行");
  });

  it("omits deduplicated field when not set", () => {
    const block = buildToolExecutionContext([{
      toolId: "music_play_track",
      args: { candidateRef: "ctx_song_1" },
      output: "ok",
      status: "succeeded",
      terminal: true,
      retryable: false,
    }]);

    expect(block).not.toContain('"deduplicated"');
  });

  it("distinguishes browser fallback from a desktop playback dispatch", () => {
    const block = buildToolExecutionContext([{
      toolId: "music_play_track",
      args: { candidateRef: "ctx_song_1" },
      output: JSON.stringify({
        kind: "playback",
        dispatch: { state: "web_fallback", resourceType: "song", resourceId: "1" },
      }),
      status: "succeeded",
    }]);

    expect(block).toContain("web_fallback 表示已在浏览器中打开");
    expect(block).toContain("不能声称网易云桌面客户端已开始播放");
  });

  it("preserves a runtime failure as data instead of inferring it from Soul text", () => {
    const block = buildToolExecutionContext([{
      toolId: "music_play_track",
      args: { candidateRef: "ctx_missing" },
      output: "E_CONTEXT_REF_NOT_FOUND",
      status: "failed",
      errorCode: "E_CONTEXT_REF_NOT_FOUND",
    }]);

    expect(block).toContain('"status":"failed"');
    expect(block).toContain('"errorCode":"E_CONTEXT_REF_NOT_FOUND"');
  });

  it("bounds large tool outputs before adding them to the Soul prompt", () => {
    const block = buildToolExecutionContext([{
      toolId: "read_file",
      args: {},
      output: "x".repeat(20_000) + "UNBOUNDED_TAIL",
      status: "succeeded",
    }]);

    expect(block).toContain("[truncated:");
    expect(block).not.toContain("UNBOUNDED_TAIL");
  });
});
