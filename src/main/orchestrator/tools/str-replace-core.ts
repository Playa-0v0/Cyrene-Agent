// str_replace 的核心匹配与批量应用逻辑（纯字符串运算，不依赖 electron / 注册表 / fs）。
//
// 设计要点：
// - 匹配分三层，逐级放宽：精确匹配 → EOL 归一化（CRLF/LF 对齐）→ 空白归一化
//   （行 trim + 行内空白折叠）。层级越深容错越强，但替换始终作用于文件原文。
// - 空白归一化命中后按"缩进前缀替换"对齐 new_string 的缩进：
//   模型按无缩进/浅缩进给出 old/new 时，new 自动继承文件中匹配片段的真实缩进。
// - 批量 edits 顺序应用（后一个 edit 在前一个的结果上匹配），任一失败则整体
//   不生效——调用方拿到失败结果后不落盘，保证原子性。

/** 单次替换指令：old_string 必须在当前内容中唯一匹配。 */
export interface StrReplaceEdit {
  old_string: string;
  new_string: string;
}

/** 匹配失败诊断（单发与批量共用；批量额外带 editIndex）。 */
export interface StrReplaceFailureDiagnostic {
  kind: "not_found" | "multiple_matches";
  /** 批量模式下失败的 edit 序号（0-based）；单发为 undefined。 */
  editIndex?: number;
  oldStringLength: number;
  fileEol: "CRLF" | "LF";
  nearestMatch?: {
    line: number;
    similarity: number;
    context: string;
  } | null;
  matchCount?: number;
  positions?: Array<{ line: number; context: string }>;
}

export type StrReplaceFailure = {
  ok: false;
  errorCode: "INVALID_INPUT" | "OLD_STRING_NOT_FOUND" | "MULTIPLE_MATCHES";
  error: string;
  diagnostic?: StrReplaceFailureDiagnostic;
};

export type StrReplaceSuccess = {
  ok: true;
  /** 全部 edits 应用后的完整新内容。 */
  newContent: string;
  /** 任一 edit 触发了 EOL 归一化。 */
  eolNormalized: boolean;
  /** 任一 edit 触发了空白归一化匹配。 */
  whitespaceNormalized: boolean;
  /** 实际应用的 edit 数量。 */
  appliedEdits: number;
  /** 每个 edit 的替换前后片段（LF 拆行），供调用方生成行级 diff。 */
  segments: Array<{ beforeLines: string[]; afterLines: string[] }>;
};

export type StrReplaceResult = StrReplaceSuccess | StrReplaceFailure;

/** 行内空白折叠 + 去首尾空白：空白归一化匹配的比对口径。 */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** 把内容按 LF 拆行并逐行归一化（CRLF 先统一成 LF）。 */
function toNormalizedLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n").map(normalizeLine);
}

/** 取行首前导空白（空格/Tab 序列）。 */
function leadingWhitespace(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}

/**
 * 空白归一化匹配：在文件行中滑动 old_string 行数的窗口，
 * 逐行比对归一化结果。返回所有命中的窗口起始行（0-based）。
 */
function findNormalizedWindows(fileLines: string[], oldLines: string[]): number[] {
  const hits: number[] = [];
  const windowSize = oldLines.length;
  if (windowSize === 0 || windowSize > fileLines.length) return hits;

  for (let i = 0; i + windowSize <= fileLines.length; i++) {
    let matched = true;
    for (let j = 0; j < windowSize; j++) {
      if (fileLines[i + j] !== oldLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(i);
  }
  return hits;
}

/**
 * 缩进对齐：new_string 每行按文件匹配片段的真实缩进重写前导空白。
 * 规则（归一化路径下模型缩进不可信，统一对齐到文件）：
 * - 行以 old 的缩进前缀开头 → 前缀替换为文件缩进
 * - 行顶格（无前导空白）→ 直接补文件缩进
 * - 行有自己的缩进且不等于 old 前缀 → 原样保留（模型明确给了另一套缩进）
 * 空行保持空。
 */
function reindentNewString(newStr: string, oldIndent: string, fileIndent: string): string {
  if (oldIndent === fileIndent) return newStr;
  return newStr
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      if (line.startsWith(oldIndent)) {
        return fileIndent + line.slice(oldIndent.length);
      }
      if (!/^[ \t]/.test(line)) {
        return fileIndent + line;
      }
      return line;
    })
    .join("\n");
}

/** 在文件行中查找与 old_string 首行最相似的行（未命中时的诊断辅助）。 */
function findNearestMatch(
  lines: string[],
  oldStr: string,
): { line: number; similarity: number; context: string } | null {
  const firstLine = normalizeLine(oldStr.replace(/\r\n/g, "\n").split("\n")[0] || "");
  if (!firstLine) return null;

  let bestMatch: { line: number; sim: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const sim = lineSimilarity(firstLine, normalizeLine(lines[i]));
    if (sim > 0.5 && (!bestMatch || sim > bestMatch.sim)) {
      bestMatch = { line: i + 1, sim };
    }
  }
  if (!bestMatch) return null;

  const contextStart = Math.max(0, bestMatch.line - 3);
  const contextEnd = Math.min(lines.length, bestMatch.line + 2);
  const context = lines
    .slice(contextStart, contextEnd)
    .map((l, idx) => {
      const ln = contextStart + idx + 1;
      const marker = ln === bestMatch!.line ? ">" : " ";
      return `${marker} ${String(ln).padStart(4)} | ${l}`;
    })
    .join("\n");

  return { line: bestMatch.line, similarity: bestMatch.sim, context };
}

/** 字符集相似度（诊断用，弱模型纠错只需要"大概在哪"）。 */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const c of setA) {
    if (setB.has(c)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
}

/** 收集窗口（0-based 起始行 + 行数）的前后各 2 行上下文。 */
function buildWindowContext(lines: string[], start: number, size: number): string {
  const contextStart = Math.max(0, start - 2);
  const contextEnd = Math.min(lines.length, start + size + 2);
  return lines
    .slice(contextStart, contextEnd)
    .map((l, idx) => {
      const ln = contextStart + idx + 1;
      const marker = ln >= start + 1 && ln <= start + size ? ">" : " ";
      return `${marker} ${String(ln).padStart(4)} | ${l}`;
    })
    .join("\n");
}

/** 应用单个 edit：精确 → EOL 归一化 → 空白归一化，三层逐级放宽。 */
function applySingleEdit(
  content: string,
  edit: StrReplaceEdit,
  editIndex: number | undefined,
): StrReplaceResult {
  const oldStr = edit.old_string;
  const newStr = edit.new_string;
  if (!oldStr) {
    // 空文件播种：文件内容为空时允许空 old_string，new_string 整体写入。
    // 文件非空仍拒绝——防止模型漏传 old_string 把整文件误覆盖。
    if (content.length === 0) {
      return {
        ok: true,
        newContent: newStr,
        eolNormalized: false,
        whitespaceNormalized: false,
        appliedEdits: 1,
        segments: [{ beforeLines: [], afterLines: newStr.replace(/\r\n/g, "\n").split("\n") }],
      };
    }
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      error: "old_string 不能为空（文件非空）。文件为空时可传空 old_string 播种写入完整内容。",
    };
  }

  const fileEol: "CRLF" | "LF" = content.includes("\r\n") ? "CRLF" : "LF";
  const fileLines = content.split("\n");

  // ── 第一层：精确匹配（含 EOL 归一化对齐）──
  let matchStr = oldStr;
  let replaceStr = newStr;
  if (fileEol === "CRLF" && !oldStr.includes("\r")) {
    matchStr = oldStr.replaceAll("\n", "\r\n");
    replaceStr = newStr.replaceAll("\n", "\r\n");
  } else if (fileEol === "LF" && oldStr.includes("\r\n")) {
    matchStr = oldStr.replaceAll("\r\n", "\n");
    replaceStr = newStr.replaceAll("\r\n", "\n");
  }
  const eolNormalized = matchStr !== oldStr;

  const exactCount = content.split(matchStr).length - 1;
  if (exactCount === 1) {
    const newContent = content.replace(matchStr, replaceStr);
    return {
      ok: true,
      newContent,
      eolNormalized,
      whitespaceNormalized: false,
      appliedEdits: 1,
      segments: [
        {
          beforeLines: matchStr.replaceAll("\r\n", "\n").split("\n"),
          afterLines: replaceStr.replaceAll("\r\n", "\n").split("\n"),
        },
      ],
    };
  }
  if (exactCount > 1) {
    const oldLines = matchStr.split("\n");
    const positions: Array<{ line: number; context: string }> = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
      if (fileLines.slice(i, i + oldLines.length).join("\n") === matchStr) {
        positions.push({ line: i + 1, context: buildWindowContext(fileLines, i, oldLines.length) });
        if (positions.length >= 5) break;
      }
    }
    return {
      ok: false,
      errorCode: "MULTIPLE_MATCHES",
      error: `old_string 在文件中匹配 ${exactCount} 处，需要更长的上下文使其唯一。`,
      diagnostic: {
        kind: "multiple_matches",
        editIndex,
        oldStringLength: oldStr.length,
        fileEol,
        matchCount: exactCount,
        positions,
      },
    };
  }

  // ── 第二层：空白归一化匹配（行 trim + 行内空白折叠）──
  // CRLF 文件先统一到 LF 域做匹配与重组，完成后整体还原 CRLF（代价是混合
  // EOL 的文件会被顺手统一；归一化路径本就是精确匹配失败后的兜底，可接受）。
  const isCrlfFile = fileEol === "CRLF";
  const lfContent = isCrlfFile ? content.replaceAll("\r\n", "\n") : content;
  const lfLines = lfContent.split("\n");
  const oldNormalized = toNormalizedLines(oldStr);
  const fileNormalized = lfLines.map(normalizeLine);
  const windows = findNormalizedWindows(fileNormalized, oldNormalized);

  if (windows.length === 1) {
    // 命中唯一窗口：取文件原文片段（保留真实缩进），替换时对齐 new_string 缩进
    const start = windows[0];
    const size = oldNormalized.length;
    const fileSlice = lfLines.slice(start, start + size).join("\n");
    const oldIndent = leadingWhitespace(oldStr.replace(/\r\n/g, "\n").split("\n")[0] || "");
    const fileIndent = leadingWhitespace(lfLines[start] ?? "");
    const adjustedNew = reindentNewString(newStr, oldIndent, fileIndent);
    const newContentLF = [
      ...lfLines.slice(0, start),
      ...adjustedNew.split("\n"),
      ...lfLines.slice(start + size),
    ].join("\n");
    return {
      ok: true,
      newContent: isCrlfFile ? newContentLF.replaceAll("\n", "\r\n") : newContentLF,
      eolNormalized,
      whitespaceNormalized: true,
      appliedEdits: 1,
      segments: [
        {
          beforeLines: fileSlice.split("\n"),
          afterLines: adjustedNew.split("\n"),
        },
      ],
    };
  }
  if (windows.length > 1) {
    const positions = windows.slice(0, 5).map((start) => ({
      line: start + 1,
      context: buildWindowContext(lfLines, start, oldNormalized.length),
    }));
    return {
      ok: false,
      errorCode: "MULTIPLE_MATCHES",
      error: `old_string 空白归一化后在文件中匹配 ${windows.length} 处，需要更长的上下文使其唯一。`,
      diagnostic: {
        kind: "multiple_matches",
        editIndex,
        oldStringLength: oldStr.length,
        fileEol,
        matchCount: windows.length,
        positions,
      },
    };
  }

  // ── 第三层：仍未命中 → not_found 诊断 ──
  const nearest = findNearestMatch(fileLines, oldStr);
  return {
    ok: false,
    errorCode: "OLD_STRING_NOT_FOUND",
    error:
      "old_string 在文件中未找到。已自动尝试 CRLF/LF 归一化与空白/缩进归一化仍未匹配，" +
      "请用 read_file 核对实际内容（缩进、空格、标点）后重试。",
    diagnostic: {
      kind: "not_found",
      editIndex,
      oldStringLength: oldStr.length,
      fileEol,
      nearestMatch: nearest
        ? { line: nearest.line, similarity: nearest.similarity, context: nearest.context }
        : null,
    },
  };
}

/**
 * 顺序应用一批 edits（单发 = 长度 1 的数组）。
 * 任一 edit 失败立即返回失败（整体不生效，由调用方保证不落盘）。
 */
export function applyStrReplaceEdits(content: string, edits: StrReplaceEdit[]): StrReplaceResult {
  if (edits.length === 0) {
    return {
      ok: false,
      errorCode: "INVALID_INPUT",
      error: "edits 不能为空数组",
    };
  }

  let current = content;
  let eolNormalized = false;
  let whitespaceNormalized = false;
  const segments: Array<{ beforeLines: string[]; afterLines: string[] }> = [];

  for (let i = 0; i < edits.length; i++) {
    const result = applySingleEdit(current, edits[i], edits.length > 1 ? i : undefined);
    if (!result.ok) return result;
    current = result.newContent;
    eolNormalized = eolNormalized || result.eolNormalized;
    whitespaceNormalized = whitespaceNormalized || result.whitespaceNormalized;
    segments.push(...result.segments);
  }

  return {
    ok: true,
    newContent: current,
    eolNormalized,
    whitespaceNormalized,
    appliedEdits: edits.length,
    segments,
  };
}
