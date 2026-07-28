/**
 * 流式 Markdown block 解析器。
 *
 * 使用 markdown-it.parse() 获取 token，提取顶层 block，
 * 计算每个 block 在原始文本中的字符 offset。
 *
 * 顶层 block 定义：nesting=0 的 block-level token 组（如 heading、paragraph_open/close、fence、list_open/close 等）。
 * 保留最后 N 个 block 为 mutable tail，其余为 committed。
 */

import MarkdownIt from "markdown-it";

export type StreamMarkdownBlockType =
  | "paragraph"
  | "heading"
  | "list"
  | "blockquote"
  | "table"
  | "fence"
  | "code"
  | "hr"
  | "other";

export interface StreamMarkdownBlock {
  /** 唯一标识（type + index），用于跨 revision 追踪 */
  key: string;
  type: StreamMarkdownBlockType;
  /** 在原始文本中的起始字符 offset */
  startOffset: number;
  /** 在原始文本中的结束字符 offset（exclusive） */
  endOffset: number;
  /** 该 block 的原始 markdown 文本 */
  raw: string;
  /** fenced code 是否已闭合（有结束围栏） */
  closed: boolean;
  /** 指纹（type + raw），用于判断是否变化 */
  fingerprint: string;
}

/**
 * 把原始 markdown 文本解析为顶层 block 列表。
 *
 * @param md markdown-it 实例
 * @param raw 原始 markdown 文本
 * @returns 顶层 block 列表（按出现顺序）
 */
export function parseStreamingBlocks(md: MarkdownIt, raw: string): StreamMarkdownBlock[] {
  if (!raw.trim()) return [];

  const tokens = md.parse(raw, {});
  if (tokens.length === 0) return [];

  // 预计算行号 -> 字符 offset 映射
  const lineOffsets = computeLineOffsets(raw);

  const blocks: StreamMarkdownBlock[] = [];
  let i = 0;
  let blockIndex = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    // 跳过非 block-level token（如 inline）
    if (token.level > 0 || token.type === "inline") {
      i++;
      continue;
    }

    // 识别 block 类型
    const blockInfo = identifyBlock(tokens, i);
    if (!blockInfo) {
      i++;
      continue;
    }

    const { type, endIndex, closed } = blockInfo;

    // 计算 offset
    const startLine = token.map?.[0] ?? 0;
    const endToken = tokens[endIndex];
    const endLine = endToken.map?.[1] ?? startLine + 1;

    const startOffset = lineOffsets[startLine] ?? 0;
    const endOffset = endLine < lineOffsets.length ? lineOffsets[endLine] : raw.length;

    // raw 文本（包含尾部换行）
    let blockRaw = raw.slice(startOffset, endOffset);
    // 如果是最后一个 block 且没有尾部换行，补上直到 raw 末尾
    if (endIndex >= tokens.length - 1) {
      blockRaw = raw.slice(startOffset);
    }

    blocks.push({
      key: `${type}-${blockIndex}`,
      type,
      startOffset,
      endOffset: startOffset + blockRaw.length,
      raw: blockRaw,
      closed,
      fingerprint: `${type}:${blockRaw}`,
    });

    blockIndex++;
    i = endIndex + 1;
  }

  return blocks;
}

/**
 * 识别从 index i 开始的 block 类型和结束 token index。
 */
function identifyBlock(
  tokens: MarkdownIt.Token[],
  i: number,
): { type: StreamMarkdownBlockType; endIndex: number; closed: boolean } | null {
  const token = tokens[i];
  const type = token.type;

  // fence：单 token，自带 content 和 info
  if (type === "fence") {
    return { type: "fence", endIndex: i, closed: true };
  }

  // code_block：缩进代码
  if (type === "code_block") {
    return { type: "code", endIndex: i, closed: true };
  }

  // hr
  if (type === "hr") {
    return { type: "hr", endIndex: i, closed: true };
  }

  // heading_open ... heading_close
  if (type === "heading_open") {
    return findClose(tokens, i, "heading_close", "heading");
  }

  // paragraph_open ... paragraph_close
  if (type === "paragraph_open") {
    return findClose(tokens, i, "paragraph_close", "paragraph");
  }

  // blockquote_open ... blockquote_close
  if (type === "blockquote_open") {
    return findClose(tokens, i, "blockquote_close", "blockquote");
  }

  // bullet_list_start / ordered_list_start ... list end
  if (type === "bullet_list_open" || type === "ordered_list_open") {
    const closeType = type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
    return findClose(tokens, i, closeType, "list");
  }

  // table_open ... table_close
  if (type === "table_open") {
    return findClose(tokens, i, "table_close", "table");
  }

  // html_block：单 token
  if (type === "html_block") {
    return { type: "other", endIndex: i, closed: true };
  }

  // 其他未知 block token
  return { type: "other", endIndex: i, closed: true };
}

/**
 * 找到 matching close token（处理嵌套）。
 * 如果没找到 close（未闭合），返回到最后一个 token。
 */
function findClose(
  tokens: MarkdownIt.Token[],
  startIndex: number,
  closeType: string,
  blockType: StreamMarkdownBlockType,
): { type: StreamMarkdownBlockType; endIndex: number; closed: boolean } {
  let depth = 1;
  for (let j = startIndex + 1; j < tokens.length; j++) {
    if (tokens[j].type === tokens[startIndex].type) depth++;
    if (tokens[j].type === closeType) {
      depth--;
      if (depth === 0) {
        return { type: blockType, endIndex: j, closed: true };
      }
    }
  }
  // 未闭合
  return { type: blockType, endIndex: tokens.length - 1, closed: false };
}

/**
 * 预计算每行的起始字符 offset。
 * lineOffsets[0] = 0, lineOffsets[n] = 第 n 行的起始 offset。
 */
function computeLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/**
 * 把 block 列表分为 committed 和 mutable tail。
 *
 * @param blocks 全部 block 列表
 * @param mutableCount 保留为 mutable 的 block 数量（默认 2）
 * @returns { committed: StreamMarkdownBlock[], mutable: StreamMarkdownBlock[] }
 */
export function splitCommittedAndMutable(
  blocks: StreamMarkdownBlock[],
  mutableCount = 2,
): { committed: StreamMarkdownBlock[]; mutable: StreamMarkdownBlock[] } {
  if (blocks.length <= mutableCount) {
    return { committed: [], mutable: blocks };
  }
  const splitIndex = blocks.length - mutableCount;
  return {
    committed: blocks.slice(0, splitIndex),
    mutable: blocks.slice(splitIndex),
  };
}
