import { describe, it, expect, beforeEach, vi } from "vitest";

const listTools = vi.fn();
const callTool = vi.fn();
const connect = vi.fn();
const close = vi.fn();
const transportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { connect, listTools, callTool, close };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { close: transportClose };
  }),
}));

import { MusicMcpClient } from "./music-mcp-client";
import { buildChildEnv } from "./child-env";
import * as path from "node:path";

beforeEach(() => {
  listTools.mockReset();
  callTool.mockReset();
  connect.mockReset();
  close.mockReset();
  transportClose.mockReset();
});

const VENDOR = path.resolve("/tmp/vendor/cloud-music-mcp");
const RUNTIME = "/tmp/runtime";

function tool(name: string, props: Record<string, unknown>) {
  return { name, description: "", inputSchema: { type: "object", properties: props, required: Object.keys(props).filter(k => (props[k] as { required?: boolean })?.required) } };
}

describe("MusicMcpClient", () => {
  it("verifyContractOnConnect returns missing tool names", async () => {
    listTools.mockResolvedValue({ tools: [
      tool("cloud_music_get_daily_recommend", {}),
      tool("cloud_music_search", { keyword: { type: "string" } }),
      tool("cloud_music_play", {
        id: { type: "string", required: true },
        type: { type: "string" },
      }),
    ]});
    connect.mockResolvedValue(undefined);
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();
    const r = await c.verifyContractOnConnect();
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining([
      "cyrene_music_login_begin",
      "cyrene_music_login_check",
      "cyrene_music_login_cancel",
    ]));
  });

  it("verifyContractOnConnect ok when all tools present", async () => {
    listTools.mockResolvedValue({ tools: [
      tool("cloud_music_get_daily_recommend", {}),
      tool("cloud_music_search", { keyword: { type: "string" } }),
      tool("cloud_music_play", {
        id: { type: "string", required: true },
        type: { type: "string" },
      }),
      tool("cyrene_music_login_begin", {}),
      tool("cyrene_music_login_check", { session_id: { type: "string" } }),
      tool("cyrene_music_login_cancel", { session_id: { type: "string" } }),
      tool("cyrene_music_validate_session", {}),
    ]});
    connect.mockResolvedValue(undefined);
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();
    expect((await c.verifyContractOnConnect()).ok).toBe(true);
  });

  it("calls cloud_music_play through the data MCP boundary", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    callTool.mockResolvedValue({ content: [{ type: "text", text: "已发送播放指令: song 123" }] });
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();

    await expect(c.callDataTool("cloud_music_play", { id: "123", type: "song" }))
      .resolves.toBe("已发送播放指令: song 123");
    expect(callTool).toHaveBeenCalledWith({
      name: "cloud_music_play",
      arguments: { id: "123", type: "song" },
    });
  });

  it("throws when MCP reports isError instead of treating its text as data", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    callTool.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "playback tool crashed" }],
    });
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();

    await expect(c.callDataTool("cloud_music_play", { id: "123", type: "song" }))
      .rejects.toThrow("E_MCP_TOOL_FAILED");
  });

  it("callDataTool rejects tool not in DATA allowlist", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();
    await expect(c.callDataTool("cloud_music_login", {})).rejects.toThrow(/E_TOOL_NOT_ALLOWED/);
  });

  it("callAuthTool rejects tool not in AUTH allowlist", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();
    await expect(c.callAuthTool("cloud_music_search", {})).rejects.toThrow(/E_TOOL_NOT_ALLOWED/);
  });

  it("calls the dedicated startup session validator", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ state: "valid" }) }] });
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();

    await expect(c.callAuthTool("cyrene_music_validate_session", {})).resolves.toEqual({ state: "valid" });
    expect(callTool).toHaveBeenCalledWith({ name: "cyrene_music_validate_session", arguments: {} });
  });

  it("forwards env from buildChildEnv", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    process.env.PATH = "/usr/bin";
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();
    const sdk = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const inst = (sdk.StdioClientTransport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inst.env).toBeDefined();
    expect((inst.env as NodeJS.ProcessEnv).CYRENE_MUSIC_STORAGE_DIR).toBe(RUNTIME);
    expect((inst.env as NodeJS.ProcessEnv).MINIMAX_API_KEY).toBeUndefined();
  });

  it("getRootPid returns undefined before connect", () => {
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    expect(c.getRootPid()).toBeUndefined();
  });

  it("getRootPid reads pid from StdioClientTransport after connect", async () => {
    listTools.mockResolvedValue({ tools: [] });
    connect.mockResolvedValue(undefined);
    const sdk = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const Ctor = sdk.StdioClientTransport as unknown as { mockImplementation: (impl: () => unknown) => void };
    // Match the real SDK shape: StdioClientTransport exposes a public `pid` getter.
    Ctor.mockImplementation(function () {
      return { close: transportClose, pid: 4242 };
    });
    const c = new MusicMcpClient(VENDOR, RUNTIME);
    await c.connect();
    expect(c.getRootPid()).toBe(4242);
  });
});
