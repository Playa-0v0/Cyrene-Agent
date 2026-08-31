// 通用模态框：confirm / html / input 三套 overlay
// 从 settings.ts 抽离。依赖 modalState（./modal-state）与全局 document。
// Electron 禁用了 window.prompt / window.confirm，所以自建 overlay 实现。

import { modalState } from "./modal-state";

export function _initModalOverlay(): void {
  if (modalState.cyOverlay) return;
  modalState.cyOverlay = document.createElement("div");
  modalState.cyOverlay.id = "cy-modal-overlay";
  modalState.cyOverlay.className = "cy-modal-overlay is-hidden";
  modalState.cyOverlay.innerHTML = [
    '<div class="cy-modal" role="alertdialog" aria-modal="true">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-modal-icon">📌</span>',
    '    <h3 class="cy-modal__title" id="cy-modal-title">提示</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <p class="cy-modal__body" id="cy-modal-message">确认执行此操作吗？</p>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-modal-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-modal-confirm">确定</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(modalState.cyOverlay);
}

export function showModal(options: { title: string; message: string; icon?: string; confirmText?: string; cancelText?: string }): Promise<boolean> {
  _initModalOverlay();
  if (!modalState.cyOverlay) return Promise.resolve(false);
  var iconEl = modalState.cyOverlay.querySelector("#cy-modal-icon") as HTMLElement;
  var titleEl = modalState.cyOverlay.querySelector("#cy-modal-title") as HTMLElement;
  var msgEl = modalState.cyOverlay.querySelector("#cy-modal-message") as HTMLElement;
  var cancelBtn = modalState.cyOverlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  var confirmBtn = modalState.cyOverlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;
  iconEl.innerHTML = options.icon || "📌";
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  cancelBtn.textContent = options.cancelText || "取消";
  confirmBtn.textContent = options.confirmText || "确定";
  modalState.cyOverlay.classList.remove("is-hidden");
  return new Promise(function (resolve) {
    var cleanup = function (result: boolean) {
      modalState.cyOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    var onCancel = function () { cleanup(false); };
    var onConfirm = function () { cleanup(true); };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

function _initHtmlModalOverlay(): void {
  if (modalState.cyHtmlOverlay) return;
  modalState.cyHtmlOverlay = document.createElement("div");
  modalState.cyHtmlOverlay.id = "cy-html-modal-overlay";
  modalState.cyHtmlOverlay.className = "cy-modal-overlay is-hidden";
  modalState.cyHtmlOverlay.innerHTML = [
    '<div class="cy-modal cy-html-modal" role="dialog" aria-modal="true">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-html-modal-icon">📌</span>',
    '    <h3 class="cy-modal__title" id="cy-html-modal-title">说明</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <div class="cy-html-modal__body" id="cy-html-modal-body"></div>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="btn-primary" id="cy-html-modal-confirm">知道了</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(modalState.cyHtmlOverlay);
}

/**
 * 富文本模态框（基于 cy-modal 样式但使用独立 overlay，避免与 showModal 冲突）。
 * 用于"音色快速复刻"这种需要展示多组说明（规格 / 费用 / 过期规则）的场景。
 * 调用方负责传入安全的 HTML（项目内固定字符串）；若内容来自用户/网络必须先 escapeHtml。
 */
export function showHtmlModal(options: { title: string; htmlBody: string; icon?: string; confirmText?: string }): Promise<void> {
  _initHtmlModalOverlay();
  if (!modalState.cyHtmlOverlay) return Promise.resolve();
  const iconEl = modalState.cyHtmlOverlay.querySelector("#cy-html-modal-icon") as HTMLElement;
  const titleEl = modalState.cyHtmlOverlay.querySelector("#cy-html-modal-title") as HTMLElement;
  const bodyEl = modalState.cyHtmlOverlay.querySelector("#cy-html-modal-body") as HTMLElement;
  const confirmBtn = modalState.cyHtmlOverlay.querySelector("#cy-html-modal-confirm") as HTMLButtonElement;
  iconEl.innerHTML = options.icon || "📌";
  titleEl.textContent = options.title;
  bodyEl.innerHTML = options.htmlBody;
  confirmBtn.textContent = options.confirmText || "知道了";
  modalState.cyHtmlOverlay.classList.remove("is-hidden");
  return new Promise((resolve) => {
    const cleanup = () => {
      modalState.cyHtmlOverlay?.classList.add("is-hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      resolve();
    };
    const onConfirm = () => cleanup();
    confirmBtn.addEventListener("click", onConfirm);
  });
}

// Inline input modal (Electron 禁用了 window.prompt，所以自己实现)
function _initInputOverlay(): void {
  if (modalState.cyInputOverlay) return;
  modalState.cyInputOverlay = document.createElement("div");
  modalState.cyInputOverlay.id = "cy-input-overlay";
  modalState.cyInputOverlay.className = "cy-modal-overlay is-hidden";
  modalState.cyInputOverlay.innerHTML = [
    '<div class="cy-modal" role="dialog" aria-modal="true" style="width:min(420px,90vw);">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-input-icon"><svg width="24" height="24" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
    '    <h3 class="cy-modal__title" id="cy-input-title">请输入</h3>',
    '  </div>',
    '  <hr class="cy-modal__divider">',
    '  <p class="cy-modal__body" id="cy-input-message"></p>',
    '  <input type="text" id="cy-input-field" autocomplete="off" spellcheck="false"',
    '    style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(0,0,0,0.32);color:var(--rb-text-strong,#fff);font-family:inherit;font-size:13px;outline:none;margin-bottom:12px;" />',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-input-cancel">取消</button>',
    '    <button type="button" class="btn-primary" id="cy-input-confirm">确定</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(modalState.cyInputOverlay);
}

export function showInputModal(options: {
  title: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<string | null> {
  _initInputOverlay();
  if (!modalState.cyInputOverlay) return Promise.resolve(null);
  const iconEl = modalState.cyInputOverlay.querySelector("#cy-input-icon") as HTMLElement;
  const titleEl = modalState.cyInputOverlay.querySelector("#cy-input-title") as HTMLElement;
  const msgEl = modalState.cyInputOverlay.querySelector("#cy-input-message") as HTMLElement;
  const inputEl = modalState.cyInputOverlay.querySelector("#cy-input-field") as HTMLInputElement;
  const cancelBtn = modalState.cyInputOverlay.querySelector("#cy-input-cancel") as HTMLButtonElement;
  const confirmBtn = modalState.cyInputOverlay.querySelector("#cy-input-confirm") as HTMLButtonElement;
  iconEl.textContent = options.icon || `<svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  inputEl.value = options.defaultValue || "";
  inputEl.placeholder = options.placeholder || "";
  cancelBtn.textContent = options.cancelText || "取消";
  confirmBtn.textContent = options.confirmText || "确定";
  modalState.cyInputOverlay.classList.remove("is-hidden");
  setTimeout(() => inputEl.focus(), 30);
  return new Promise((resolve) => {
    const cleanup = (result: string | null) => {
      modalState.cyInputOverlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      inputEl.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onCancel = () => cleanup(null);
    const onConfirm = () => cleanup(inputEl.value);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    inputEl.addEventListener("keydown", onKey);
  });
}
