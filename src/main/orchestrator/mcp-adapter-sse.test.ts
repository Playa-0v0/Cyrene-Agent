import { describe, it, expect, vi, beforeEach } from "vitest";

// tool-registry 通过 ../rag/index 间接 import electron；这里 stub 掉避免 electron 二进制检查
vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp") },
}));

// mock 整个 SDK,在测试里不需要真连
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}));

const mockStdioConnect = vi.fn().mockResolvedValue(undefined);
const mockSseConnect = vi.fn().mockResolvedValue(undefined);
const mockSseClose = vi.fn().mockResolvedValue(undefined);
const mockStdioClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
		return {
			close: mockStdioClose,
			_opts: opts,
		};
	}),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn().mockImplementation(function (this: unknown, url: unknown) {
		return {
			close: mockSseClose,
			onerror: null as ((err: Error) => void) | null,
			_url: url,
		};
	}),
}));

import { connectMcpServer, disconnectMcpServer } from "./mcp-adapter";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { toolRegistry } from "./tool-registry";

describe("mcp-adapter transport split", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 清空 registry,避免互相污染
		for (const t of toolRegistry.getAllTools()) toolRegistry.unregister(t.id);
	});

	it("stdio transport uses StdioClientTransport with command/args", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-stdio",
			name: "Test Stdio",
			transport: "stdio",
			command: "node",
			args: ["foo.js"],
		});

		expect(StdioClientTransport).toHaveBeenCalledWith({
			command: "node",
			args: ["foo.js"],
			env: undefined,
			cwd: undefined,
		});
		expect(SSEClientTransport).not.toHaveBeenCalled();
	});

	it("sse transport uses SSEClientTransport with URL", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-sse",
			name: "Test SSE",
			transport: "sse",
			url: "https://example.com/sse",
		});

		expect(SSEClientTransport).toHaveBeenCalledWith(new URL("https://example.com/sse"));
		expect(StdioClientTransport).not.toHaveBeenCalled();
	});

	it("sse transport without url throws", async () => {
		await expect(
			connectMcpServer({
				id: "test-sse-bad",
				name: "Bad SSE",
				transport: "sse",
			})
		).rejects.toThrow(/sse transport requires url/);
	});

	it("propagates MCP isError as a failed tool execution", async () => {
		const callTool = vi.fn().mockResolvedValue({
			isError: true,
			content: [{ type: "text", text: "remote tool failed" }],
		});
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({
					tools: [{
						name: "explode",
						description: "always fails",
						inputSchema: { type: "object", properties: { value: { type: "string" } } },
					}],
				}),
				callTool,
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-error",
			name: "Test Error",
			transport: "stdio",
			command: "node",
			args: ["server.js"],
		});
		const tool = toolRegistry.getById("test-error-explode");

		await expect(tool?.execute({ value: "x" })).rejects.toThrow("E_MCP_TOOL_FAILED");
		expect(callTool).toHaveBeenCalledWith({ name: "explode", arguments: { value: "x" } });
	});
});
