/**
 * Memory LLM 统一错误类型。
 *
 * 所有从 Memory LLM Client 抛出的错误都是这些类型的实例，
 * 让 trace 和用户诊断能区分超时、HTTP 错误、协议错误和配置错误。
 */

export class MemoryLlmTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly operation: string,
  ) {
    super(`Memory LLM [${operation}] timed out after ${timeoutMs}ms`);
    this.name = "MemoryLlmTimeoutError";
  }
}

export class MemoryLlmHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly operation: string,
    public readonly responseBody?: string,
  ) {
    super(`Memory LLM [${operation}] HTTP ${statusCode}`);
    this.name = "MemoryLlmHttpError";
  }
}

export class MemoryLlmProtocolError extends Error {
  constructor(
    public readonly operation: string,
    public readonly detail: string,
  ) {
    super(`Memory LLM [${operation}] protocol error: ${detail}`);
    this.name = "MemoryLlmProtocolError";
  }
}

export class MemoryLlmConfigurationError extends Error {
  constructor(detail: string) {
    super(`Memory LLM configuration error: ${detail}`);
    this.name = "MemoryLlmConfigurationError";
  }
}
