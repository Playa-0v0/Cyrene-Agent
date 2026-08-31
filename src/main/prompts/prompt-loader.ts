import * as fs from "node:fs";
import { findPromptPath } from "../external-content-paths";

/**
 * 加载 prompts 目录下的 Markdown/文本文件。
 * 文件不存在或读取失败时返回空字符串，避免调用方因 prompt 缺失崩溃。
 */
export function loadPromptFile(filename: string): string {
  try {
    const filePath = findPromptPath(filename);
    if (!filePath) return "";
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}
