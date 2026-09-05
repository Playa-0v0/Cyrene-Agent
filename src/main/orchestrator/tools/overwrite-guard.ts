// 覆写防护：软截断检测（纯函数，无 fs / electron 依赖）。
//
// 背景：弱模型在长上下文 + 多工具场景下可能生成被截断的 content 后仍然发起
// 覆盖写，把既有大文件毁成半篇（详见 internal-issue 2026-09-05）。
// 防护规则（拍板值，可调）：原文件 ≥ MIN_LINES 行且新内容行数占比 < RATIO
// 才拒绝——小文件合法缩水很常见（10 行笔记整理成 4 行），大文件骤降才是
// 软截断的高危特征。
//
// 拒绝不代表文件被写坏：调用方在检查通过前不得落盘。

/** 骤降检查的最小行数门槛：原文件低于此行数不拦截 */
export const OVERWRITE_DROP_MIN_LINES = 50;

/** 新内容占原内容行数的比例下限：低于此比例（且原文件够大）才拦截 */
export const OVERWRITE_DROP_RATIO = 0.5;

export interface OverwriteDropDecision {
  blocked: boolean;
  oldLineCount: number;
  newLineCount: number;
  /** newLineCount / oldLineCount；oldLineCount 为 0 时为 1 */
  ratio: number;
}

/** 行数口径：按 LF 拆分、末尾空行不计（与 countLines 一致）。 */
function lineCountOf(text: string): number {
  if (!text) return 0;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/**
 * 覆盖写骤降检查。
 * @param existingContent 原文件当前内容（写前现读，不用 review 基线——
 *   基线是本 run 第一次修改前的状态，本轮早前可能已改过，diff 会失真）
 * @param newContent 即将写入的新内容
 */
export function checkOverwriteDrop(existingContent: string, newContent: string): OverwriteDropDecision {
  const oldLineCount = lineCountOf(existingContent);
  const newLineCount = lineCountOf(newContent);
  const ratio = oldLineCount > 0 ? newLineCount / oldLineCount : 1;

  const blocked =
    oldLineCount >= OVERWRITE_DROP_MIN_LINES &&
    ratio < OVERWRITE_DROP_RATIO;

  return { blocked, oldLineCount, newLineCount, ratio };
}

/** 骤降拒绝报错文案：引导模型走合法路径而不是原样重试。 */
export function overwriteDropMessage(decision: OverwriteDropDecision): string {
  const percent = Math.round(decision.ratio * 100);
  return (
    `覆盖写被拒绝：原文件 ${decision.oldLineCount} 行，新内容仅 ${decision.newLineCount} 行（${percent}%），` +
    "疑似模型输出被截断。\n" +
    "如需局部修改请改用 str_replace（内容锚点替换）；" +
    "确需整文件重写请用 str_replace（old_string = 原文件全文）或请求用户协助，不要直接覆盖。"
  );
}
