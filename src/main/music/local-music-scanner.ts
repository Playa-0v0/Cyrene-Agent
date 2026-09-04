// 本地音乐文件夹扫描 —— 递归找出可导入的音频文件。
//
// 单独成模块是为了能脱离 Electron 的 dialog 单测：扫描逻辑（扩展名过滤、
// 递归深度、数量上限、跳过隐藏目录）是真正会出错的部分，文件框只是入口。
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 与 ipc-handlers 里文件选择框的 filters 保持一致。 */
export const AUDIO_EXTENSIONS = [".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac"] as const;

/** 递归深度上限：正常音乐库不会比这更深，防软链接绕圈跑飞。 */
const MAX_DEPTH = 8;
/** 单次导入的文件数量上限，防止误选 C:\ 之类的目录把主进程卡死。 */
const MAX_FILES = 5000;

export interface ScanResult {
  files: string[];
  /** 命中上限时为 true，调用方应当提示用户结果被截断。 */
  truncated: boolean;
}

function isAudio(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 递归扫描目录下的音频文件。
 *
 * 刻意的取舍：
 * - 跳过 . 开头的目录（.git / .cache 之类），音乐库里没有这种东西
 * - 用 withFileTypes 避免对每个条目再 stat 一次
 * - 单个子目录读失败（权限）不中断整体扫描，只是跳过
 */
export async function scanAudioFiles(root: string): Promise<ScanResult> {
  const files: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 权限不足等：跳过这一支，不影响其它目录
    }
    // 先文件后目录：浅层结果优先进列表，被截断时拿到的也是更相关的
    for (const e of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return; }
      if (e.isFile() && isAudio(e.name)) files.push(path.join(dir, e.name));
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await walk(path.join(dir, e.name), depth + 1);
      }
    }
  }

  await walk(root, 0);
  return { files, truncated };
}
