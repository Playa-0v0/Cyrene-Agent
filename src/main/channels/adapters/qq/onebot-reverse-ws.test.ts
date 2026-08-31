import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { OneBotReverseWsServer, isLoopbackHost, resolveOneBotListenHost } from "./onebot-reverse-ws";

describe("OneBotReverseWsServer", () => {
  it("resolves loopback and WSL interface modes", () => {
    expect(resolveOneBotListenHost("loopback", undefined, {})).toEqual({ host: "127.0.0.1", resolvedMode: "loopback" });
    expect(resolveOneBotListenHost("wsl", undefined, {
      "vEthernet (WSL)": [{ address: "172.20.0.1", netmask: "255.255.240.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.20.0.1/20" }],
    })).toEqual({ host: "172.20.0.1", resolvedMode: "wsl" });
    expect(resolveOneBotListenHost("auto", undefined, {})).toEqual({ host: "127.0.0.1", resolvedMode: "loopback" });
  });

  it("classifies loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("172.20.0.1")).toBe(false);
  });

  it("requires a token when binding all interfaces", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "custom",
      customHost: "0.0.0.0",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    await expect(server.start()).rejects.toThrow(/Access Token/);
  });

  it("requires a token for non-loopback custom hosts (LAN, IPv6 any)", async () => {
    for (const customHost of ["192.168.1.10", "::"]) {
      const server = new OneBotReverseWsServer({
        listenMode: "custom",
        customHost,
        port: 0,
        onEvent: () => undefined,
        onClientConnected: () => undefined,
      });
      await expect(server.start()).rejects.toThrow(/Access Token/);
    }
  });

  it("allows a custom loopback host without a token", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "custom",
      customHost: "127.0.0.1",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    const info = await server.start();
    expect(info.host).toBe("127.0.0.1");
    await server.stop();
  });

  it("stop() does not hang on idle keep-alive connections", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    const info = await server.start();
    // 模拟浏览器/扫描器：普通 GET 拿到 404 后连接作为 keep-alive 空闲连接留在 server 上
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: info.port, path: "/", agent }, (res) => {
        expect(res.statusCode).toBe(404);
        res.resume();
        res.once("end", resolve);
      });
      req.once("error", reject);
    });
    const startedAt = Date.now();
    await server.stop();
    agent.destroy();
    // 修复前 server.close() 要等空闲 keep-alive 连接超时（默认 5s）才回调
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("allows an unauthenticated loopback client when token is empty", async () => {
    let connected = false;
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => { connected = true; },
    });
    const info = await server.start();
    const socket = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(connected).toBe(true);
    } finally {
      socket.terminate();
      await server.stop();
    }
  });

  it("rejects a wrong token and accepts an authenticated universal client", async () => {
    let connected = false;
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      accessToken: "secret-token",
      onEvent: () => undefined,
      onClientConnected: () => { connected = true; },
    });
    const info = await server.start();
    try {
      const wrongStatus = await new Promise<number>((resolve) => {
        const socket = new WebSocket(info.url, { headers: { Authorization: "Bearer wrong", "X-Self-ID": "10001" } });
        socket.once("unexpected-response", (_req, response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          socket.terminate();
          resolve(status);
        });
        socket.once("error", () => undefined);
      });
      expect(wrongStatus).toBe(401);

      const queryOnlyStatus = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`${info.url}?access_token=secret-token`, { headers: { "X-Self-ID": "10001" } });
        socket.once("unexpected-response", (_req, response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          socket.terminate();
          resolve(status);
        });
        socket.once("error", () => undefined);
      });
      expect(queryOnlyStatus).toBe(401);

      const socket = new WebSocket(info.url, { headers: { Authorization: "Bearer secret-token", "X-Self-ID": "10001" } });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(connected).toBe(true);
      socket.terminate();
    } finally {
      await server.stop();
    }
  });

  it("replaces a reconnect from the same account and rejects a different account", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    const info = await server.start();
    const first = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });
    try {
      const other = new WebSocket(info.url, { headers: { "X-Self-ID": "20002" } });
      const otherClose = new Promise<number>((resolve) => other.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        other.once("open", resolve);
        other.once("error", reject);
      });
      await expect(otherClose).resolves.toBe(4003);
      expect(first.readyState).toBe(WebSocket.OPEN);

      const replacement = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
      const firstClose = new Promise<number>((resolve) => first.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        replacement.once("open", resolve);
        replacement.once("error", reject);
      });
      await expect(firstClose).resolves.toBe(4001);
      expect(replacement.readyState).toBe(WebSocket.OPEN);
      replacement.terminate();
    } finally {
      first.terminate();
      await server.stop();
    }
  });

  it("closes a silent connection after the heartbeat deadline", async () => {
    const server = new OneBotReverseWsServer({
      listenMode: "loopback",
      port: 0,
      heartbeatTimeoutMs: 20,
      onEvent: () => undefined,
      onClientConnected: () => undefined,
    });
    const info = await server.start();
    const socket = new WebSocket(info.url, { headers: { "X-Self-ID": "10001" } });
    try {
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await expect(closed).resolves.toBe(4000);
    } finally {
      socket.terminate();
      await server.stop();
    }
  });
});
