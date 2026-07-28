/**
 * 搜索后端工具过滤与 API Key 校验。
 *
 * 每轮根据当前搜索后端设置，决定暴露哪些搜索工具给 Action Gate。
 * 搜索后端互斥：同一时间只暴露一个搜索后端的工具。
 */

// ── API Key 校验 ──────────────────────────

export interface KeyValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
  diagnostics: { length: number; trimmed: boolean; hasNonAscii: boolean; hasControlChars: boolean };
}

/**
 * 校验搜索 API Key 的安全性。
 * 不泄漏原始 Key，只返回脱敏诊断。
 */
export function validateSearchApiKey(rawKey: string, label: string): KeyValidationResult {
  const originalLength = rawKey.length;
  const normalized = rawKey.trim();
  const trimmed = normalized.length !== originalLength;
  const hasNonAscii = /[^\x20-\x7E]/.test(normalized);
  const hasControlChars = /[\x00-\x1F\x7F]/.test(normalized);
  const diagnostics = { length: normalized.length, trimmed, hasNonAscii, hasControlChars };

  if (normalized.length === 0) {
    return { valid: false, normalized: "", error: `${label}不能为空`, diagnostics };
  }
  if (hasControlChars) {
    return { valid: false, normalized: "", error: `${label}包含控制字符，请重新输入`, diagnostics };
  }
  if (hasNonAscii) {
    return { valid: false, normalized: "", error: `${label}包含非 ASCII 字符，请确认是否复制了多余内容`, diagnostics };
  }
  return { valid: true, normalized, diagnostics };
}

// ── 搜索工具过滤 ──────────────────────────

export const BUILTIN_SEARCH_TOOL_ID = "web_search";
export const MINIMAX_SEARCH_TOOL_PREFIX = "minimax-web-search-";

export type SearchBackend = "off" | "bocha" | "tavily" | "minimax";

/**
 * 判断一个工具是否应该根据当前搜索后端设置被暴露。
 * 返回 true = 暴露，false = 隐藏。
 */
export function shouldExposeSearchTool(
  toolId: string,
  activeBackend: SearchBackend,
): boolean {
  if (toolId === BUILTIN_SEARCH_TOOL_ID) {
    return activeBackend === "bocha" || activeBackend === "tavily";
  }
  if (toolId.startsWith(MINIMAX_SEARCH_TOOL_PREFIX)) {
    return activeBackend === "minimax";
  }
  return true; // 非搜索工具正常暴露
}

/**
 * 从工具列表中过滤出当前搜索后端对应的搜索工具。
 * 非搜索工具不受影响。
 */
export function filterToolsBySearchBackend<T extends { id: string }>(
  tools: T[],
  activeBackend: SearchBackend,
): T[] {
  return tools.filter((tool) => shouldExposeSearchTool(tool.id, activeBackend));
}
