// 通用解析纯函数：字符串 → 数值/命令行
// 从 settings.ts 抽离，无 DOM/状态依赖。

/** 解析正整数；不合法时抛出 th（错误信息字符串）。 */
export function parsePositiveIntOrThrow(input: string, th: any) {
  if (!/^[0-9]+$/.test(input)) {
    throw th;
  }
  if (isNaN(input as any)) {
    throw th;
  }
  const result = parseInt(input);
  if (Number.isNaN(result) || result <= 0) {
    throw th;
  }
  return result;
}

/** 简易命令行解析：支持引号包裹的参数，拆分为 { command, args }。 */
export function parseCommandLine(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (!trimmed) return { command: "", args: [] };
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of trimmed) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return { command: parts[0] || "", args: parts.slice(1) };
}
