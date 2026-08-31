/**
 * 只在流式回复的开头探测系统时间元数据。
 *
 * 模型偶尔会把提示词中的 `[YYYY-MM-DD HH:mm, Area/City]` 原样复述出来。
 * 这里是一个很窄的字符级状态机：只有完整匹配该格式才丢弃；一旦不匹配，
 * 已缓冲内容立即原样输出，避免误伤正常的方括号内容。
 */
const MAX_TIMESTAMP_PROBE_LENGTH = 64;

type ProbeResult = "pending" | "matched" | "mismatch";

function inspectTimestampProbe(value: string): ProbeResult {
  const fixedTokens: Array<{ literal?: string; digits?: number }> = [
    { literal: "[" },
    { digits: 4 },
    { literal: "-" },
    { digits: 2 },
    { literal: "-" },
    { digits: 2 },
    { literal: " " },
    { digits: 2 },
    { literal: ":" },
    { digits: 2 },
    { literal: ", " },
  ];
  let index = 0;

  for (const token of fixedTokens) {
    const expected = token.literal ?? "";
    if (token.digits) {
      for (let digit = 0; digit < token.digits; digit += 1) {
        if (index === value.length) return "pending";
        if (!/\d/.test(value[index])) return "mismatch";
        index += 1;
      }
      continue;
    }
    for (const character of expected) {
      if (index === value.length) return "pending";
      if (value[index] !== character) return "mismatch";
      index += 1;
    }
  }

  const timezone = value.slice(index);
  const closingIndex = timezone.indexOf("]");
  if (closingIndex >= 0) {
    if (closingIndex !== timezone.length - 1) return "mismatch";
    return /^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/.test(timezone.slice(0, -1))
      ? "matched"
      : "mismatch";
  }

  return /^[A-Za-z_]*(?:\/[A-Za-z_+-]*)*$/.test(timezone) ? "pending" : "mismatch";
}

export class ChatTimeStreamPrefixFilter {
  private mode: "probing" | "passthrough" | "trimming" = "probing";
  private buffer = "";

  push(chunk: string): string {
    if (!chunk) return "";
    if (this.mode === "passthrough") return chunk;
    if (this.mode === "trimming") {
      const visibleIndex = chunk.search(/\S/);
      if (visibleIndex < 0) return "";
      if (chunk[visibleIndex] === "[") {
        this.mode = "probing";
        this.buffer = "";
        return this.push(chunk.slice(visibleIndex));
      }
      this.mode = "passthrough";
      return chunk.slice(visibleIndex);
    }

    let output = "";
    for (let index = 0; index < chunk.length; index += 1) {
      if (this.mode === "trimming") {
        if (/\s/.test(chunk[index])) continue;
        if (chunk[index] === "[") {
          this.mode = "probing";
          this.buffer = "[";
          continue;
        }
        this.mode = "passthrough";
        output += chunk.slice(index);
        break;
      }
      this.buffer += chunk[index];
      const result = inspectTimestampProbe(this.buffer);
      if (result === "matched") {
        this.buffer = "";
        this.mode = "trimming";
        continue;
      }
      if (result === "mismatch" || this.buffer.length >= MAX_TIMESTAMP_PROBE_LENGTH) {
        output += this.buffer + chunk.slice(index + 1);
        this.buffer = "";
        this.mode = "passthrough";
        break;
      }
    }
    return output;
  }

  /** 在流结束时放行尚不能确定的开头，绝不吞掉正常回复。 */
  finish(): string {
    if (this.mode !== "probing") return "";
    const remaining = this.buffer;
    this.buffer = "";
    this.mode = "passthrough";
    return remaining;
  }
}
