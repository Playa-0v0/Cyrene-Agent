function explicitlyRejectsStreaming(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /(?:stream(?:ing)?[^\r\n]{0,40}(?:not supported|unsupported|must be false|disabled|unavailable)|(?:not supported|unsupported)[^\r\n]{0,40}stream(?:ing)?|only non[- ]?stream|不支持.{0,12}流式|流式.{0,12}不支持)/i.test(body);
}

/** Only permits a non-stream retry for an explicit provider capability rejection. */
export function isExplicitStreamUnsupported(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; message?: unknown; cause?: unknown };
    const status = typeof record.status === "number" ? record.status : 0;
    const message = typeof record.message === "string" ? record.message : "";
    if (explicitlyRejectsStreaming(status, message) || explicitlyRejectsStreaming(400, message)) return true;
    current = record.cause;
  }
  return false;
}
