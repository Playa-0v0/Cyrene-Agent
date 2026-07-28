/**
 * 代码块复制按钮 - 事件委托。
 *
 * 在聊天模块初始化时调用一次 `initCodeBlockController(messagesContainer)`，
 * 在消息列表根节点上注册一个 click 事件委托。
 * 不每条消息或每次 render 重复绑定。
 *
 * 点击 .code-block__copy 时：
 * 1. 找到同 .code-block 下的 .code-block__code > pre > code（Shiki 或 fallback）
 * 2. 读 textContent（原始代码文本，不是高亮 HTML）
 * 3. 写入 clipboard
 * 4. 按钮文案短暂切换为"已复制"，恢复"复制"
 */

const COPY_TEXT = "复制";
const COPIED_TEXT = "已复制";
const COPIED_RESTORE_MS = 2000;

/**
 * 在指定根节点上初始化代码块复制按钮的事件委托。
 * 只应调用一次。
 */
export function initCodeBlockController(rootEl: HTMLElement): void {
  rootEl.addEventListener("click", async (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const copyBtn = target.closest(".code-block__copy") as HTMLElement | null;
    if (!copyBtn) return;

    const codeBlock = copyBtn.closest(".code-block") as HTMLElement | null;
    if (!codeBlock) return;

    // 读取代码文本：从 .code-block__code > pre > code 的 textContent
    const codeContainer = codeBlock.querySelector(".code-block__code");
    if (!codeContainer) return;

    const codeEl = codeContainer.querySelector("code") || codeContainer.querySelector("pre");
    if (!codeEl) return;

    const rawText = codeEl.textContent ?? "";
    if (!rawText) return;

    try {
      await navigator.clipboard.writeText(rawText);
      copyBtn.textContent = COPIED_TEXT;
      copyBtn.classList.add("is-copied");

      setTimeout(() => {
        copyBtn.textContent = COPY_TEXT;
        copyBtn.classList.remove("is-copied");
      }, COPIED_RESTORE_MS);
    } catch (err) {
      console.error("[code-block] 复制失败:", err);
      copyBtn.textContent = "复制失败";

      setTimeout(() => {
        copyBtn.textContent = COPY_TEXT;
      }, COPIED_RESTORE_MS);
    }
  });
}
