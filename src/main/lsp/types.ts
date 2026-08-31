import type { Position } from "vscode-languageserver-types";

export const LSP_OPERATIONS = [
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
] as const;

export type LspOperation = typeof LSP_OPERATIONS[number];

export const LSP_ERROR_CODES = [
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
] as const;

export type LspErrorCode = typeof LSP_ERROR_CODES[number];

export interface LspServerCommand {
  command: string;
  args: string[];
}

export interface LspServerDefinition {
  id: string;
  extensions: string[];
  commands: LspServerCommand[];
  rootMarkers: string[];
  installHint: string;
  initializationOptions?: unknown;
}

/** 用户为已知服务提供的本地命令覆盖；不会由模型参数直接构造。 */
export interface LspServerOverride {
  id: string;
  command?: string;
  args?: string[];
  extensions?: string[];
  initializationOptions?: unknown;
}

export interface LspPositionInput {
  /** 供模型使用的一基行号。 */
  line: number;
  /** 供模型使用的一基字符号。 */
  character: number;
}

export interface LspQuery {
  operation: LspOperation;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
  /** 仅用于调用层级的第二步；必须来自同一语言服务此前返回的条目。 */
  item?: Record<string, unknown>;
}

export interface LspToolResult {
  serverId: string;
  operation: LspOperation;
  workspaceRoot: string;
  items: unknown[];
  message: string;
}

export class LspContractError extends Error {
  constructor(public readonly code: LspErrorCode, message: string = code) {
    super(`${code}: ${message}`);
    this.name = "LspContractError";
  }
}

/** 将模型可见的一基位置转换为 LSP 协议使用的零基位置。 */
export function toProtocolPosition(input: LspPositionInput): Position {
  if (!Number.isInteger(input.line) || input.line < 1
    || !Number.isInteger(input.character) || input.character < 1) {
    throw new LspContractError("LSP_POSITION_INVALID", "line 和 character 必须是从 1 开始的整数");
  }
  return { line: input.line - 1, character: input.character - 1 };
}
