import { describe, expect, it } from "vitest";
import {
  LSP_ERROR_CODES,
  LSP_OPERATIONS,
  toProtocolPosition,
  type LspToolResult,
} from "./types";

describe("LSP shared contracts", () => {
  it("freezes the supported semantic operations", () => {
    expect(LSP_OPERATIONS).toEqual([
      "goToDefinition",
      "findReferences",
      "hover",
      "documentSymbol",
      "workspaceSymbol",
      "goToImplementation",
      "diagnostics",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ]);
  });

  it("converts one-based model positions to zero-based protocol positions", () => {
    expect(toProtocolPosition({ line: 1, character: 1 })).toEqual({ line: 0, character: 0 });
    expect(toProtocolPosition({ line: 12, character: 5 })).toEqual({ line: 11, character: 4 });
    expect(() => toProtocolPosition({ line: 0, character: 1 })).toThrow("LSP_POSITION_INVALID");
    expect(() => toProtocolPosition({ line: 1.5, character: 1 })).toThrow("LSP_POSITION_INVALID");
  });

  it("exposes stable result and error contracts", () => {
    const result: LspToolResult = {
      serverId: "typescript-language-server",
      operation: "hover",
      workspaceRoot: "E:\\project",
      items: [{ kind: "markdown", value: "`foo`" }],
      message: "找到悬停信息。",
    };

    expect(result).toMatchObject({ operation: "hover", items: [{ kind: "markdown" }] });
    expect(LSP_ERROR_CODES).toEqual([
      "LSP_WORKSPACE_REQUIRED",
      "LSP_PATH_OUTSIDE_WORKSPACE",
      "LSP_FILE_NOT_FOUND",
      "LSP_SERVER_NOT_FOUND",
      "LSP_SERVER_START_FAILED",
      "LSP_INITIALIZE_TIMEOUT",
      "LSP_REQUEST_TIMEOUT",
      "LSP_REQUEST_FAILED",
      "LSP_UNSUPPORTED_OPERATION",
      "LSP_POSITION_INVALID",
    ]);
  });
});
