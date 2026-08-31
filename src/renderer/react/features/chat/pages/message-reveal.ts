/**
 * Work/Learn/Code 会先完整接收并分类模型回合，再把公开文本做展示层渐显。
 * 这不是伪造 reasoning；只改变已经收到的公开文本的呈现节奏。
 */
// 每个公开文本回合最多触发 24 次 React 更新：足够保留渐显感，避免长段落重复重渲染 Markdown。
export function splitTextForReveal(text: string, maxFrames = 24): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length === 0) return [];
  const frameCount = Math.max(1, Math.min(maxFrames, codePoints.length));
  const chunkSize = Math.ceil(codePoints.length / frameCount);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += chunkSize) {
    chunks.push(codePoints.slice(index, index + chunkSize).join(""));
  }
  return chunks;
}
