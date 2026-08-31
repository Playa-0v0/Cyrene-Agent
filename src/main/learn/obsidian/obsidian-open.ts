/**
 * Obsidian Open — 通过 obsidian:// 协议在 Obsidian 中打开笔记。
 *
 * 使用 Electron shell.openExternal 打开 obsidian:// URL。
 */

import { shell } from "electron";

/**
 * 通过 obsidian:// 协议打开指定笔记。
 *
 * @param vaultName Vault 名称（文件夹名）
 * @param filePath Vault 内文件相对路径
 * @param headingPath 可选标题路径，用于定位到具体章节
 */
export async function openNote(input: {
  vaultName: string;
  filePath: string;
  headingPath?: string[];
}): Promise<void> {
  const { vaultName, filePath, headingPath } = input;

  // 编码路径中的特殊字符
  const encodedFile = encodeURIComponent(filePath);

  let url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodedFile}`;

  // 添加标题锚点
  if (headingPath && headingPath.length > 0) {
    // obsidian:// url 中 heading 用 # 表示
    const heading = headingPath[headingPath.length - 1];
    url += `#${encodeURIComponent(heading)}`;
  }

  await shell.openExternal(url);
}
