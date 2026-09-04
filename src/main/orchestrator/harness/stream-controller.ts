/**
 * 流式控制器：管理 Progress Stream vs Final Commit。
 *
 * 模型 content 先 buffer：
 * - 有普通 tool_calls → flush 为 Progress Message
 * - 有 ask_user → discard
 * - 无 tool_calls + Completion 通过 → commit 为 Final Answer
 * - 无 tool_calls + Completion 未通过 → 不 commit，给 Runtime Feedback
 */

export class StreamController {
  private buffer: string = "";

  /** 缓存模型这一轮的 content */
  bufferProgressContent(content: string): void {
    this.buffer += content;
  }

  /** 获取当前 buffer 内容 */
  getBuffered(): string {
    return this.buffer;
  }

  /** 丢弃 buffer（ask_user 排他时） */
  discardProgressBuffer(): void {
    this.buffer = "";
  }

  /** flush buffer 为 Progress Message（有普通工具调用时） */
  flushProgressBufferAsProgress(): string | null {
    if (!this.buffer) return null;
    const content = this.buffer;
    this.buffer = "";
    return content;
  }

  /** commit buffer 为 Final Answer（Completion 通过时） */
  commitProgressBuffer(): string {
    const content = this.buffer;
    this.buffer = "";
    return content;
  }

  /** 是否有缓存的 content */
  hasBufferedContent(): boolean {
    return this.buffer.length > 0;
  }
}
