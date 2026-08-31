import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { OneBotActionClient, OneBotActionError } from "./onebot-action-client";

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  send(value: string): void {
    this.sent.push(value);
  }
}

function requestAt(socket: FakeSocket, index: number): { action: string; echo: string } {
  return JSON.parse(socket.sent[index]) as { action: string; echo: string };
}

describe("OneBotActionClient", () => {
  it("matches concurrent out-of-order responses by echo", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const first = client.call<{ value: number }>("first");
    const second = client.call<{ value: number }>("second");
    const a = requestAt(socket, 0);
    const b = requestAt(socket, 1);

    client.handleResponse({ status: "ok", retcode: 0, data: { value: 2 }, echo: b.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { value: 1 }, echo: a.echo });

    await expect(first).resolves.toEqual({ value: 1 });
    await expect(second).resolves.toEqual({ value: 2 });
    expect(client.pendingCount).toBe(0);
  });

  it("rejects failed actions", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const pending = client.call("bad");
    const request = requestAt(socket, 0);
    client.handleResponse({ status: "failed", retcode: 1404, data: null, wording: "not found", echo: request.echo });
    await expect(pending).rejects.toBeInstanceOf(OneBotActionError);
  });

  it("waits for asynchronous stream packet handlers before resolving", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const seen: number[] = [];
    const pending = client.callStream("download_file_stream", {}, async (packet) => {
      if (packet.index !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        seen.push(packet.index);
      }
    });
    const request = requestAt(socket, 0);
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_chunk", index: 0 }, echo: request.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_chunk", index: 1 }, echo: request.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "response", data_type: "file_complete" }, echo: request.echo });
    await expect(pending).resolves.toMatchObject({ type: "response" });
    expect(seen).toEqual([0, 1]);
  });

  it("times out actions and removes their pending entry", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket, 5);
    await expect(client.call("slow")).rejects.toThrow(/timeout: slow/);
    expect(client.pendingCount).toBe(0);
  });

  it("cancels every pending action when the connection closes", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const first = client.call("first");
    const second = client.call("second");
    client.rejectAll("disconnected");
    await expect(first).rejects.toThrow("disconnected");
    await expect(second).rejects.toThrow("disconnected");
    expect(client.pendingCount).toBe(0);
  });

  it("waits for prior stream handlers before rejecting a reset packet", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const seen: string[] = [];
    const pending = client.callStream("download", {}, async (packet) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.push(packet.type);
    });
    const request = requestAt(socket, 0);
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_info" }, echo: request.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "reset" }, echo: request.echo });
    await expect(pending).rejects.toThrow("OneBot stream reset");
    expect(seen).toEqual(["stream", "reset"]);
  });

  it("rejects with the callback error when an onPacket handler throws mid-stream (no unhandled rejection)", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const seen: number[] = [];
    const pending = client.callStream("download_file_stream", {}, async (packet) => {
      if (packet.index !== undefined) seen.push(packet.index);
      if (packet.index === 1) throw new Error("chunk handler failed");
    });
    const request = requestAt(socket, 0);
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_chunk", index: 0 }, echo: request.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_chunk", index: 1 }, echo: request.echo });
    // 抛错后 NapCat 仍会继续推送后续包——这些包不能产生无人处理的 rejected promise
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_chunk", index: 2 }, echo: request.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "response", data_type: "file_complete" }, echo: request.echo });
    await expect(pending).rejects.toThrow("chunk handler failed");
    expect(seen).toEqual([0, 1, 2]);
    expect(client.pendingCount).toBe(0);
  });

  it("prefers the callback error as the root cause over a subsequent stream reset", async () => {
    const socket = new FakeSocket();
    const client = new OneBotActionClient(socket as unknown as WebSocket);
    const pending = client.callStream("download", {}, (packet) => {
      if (packet.data_type === "file_info") throw new Error("duplicate file_info");
    });
    const request = requestAt(socket, 0);
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "stream", data_type: "file_info" }, echo: request.echo });
    client.handleResponse({ status: "ok", retcode: 0, data: { type: "reset" }, echo: request.echo });
    await expect(pending).rejects.toThrow("duplicate file_info");
  });
});
