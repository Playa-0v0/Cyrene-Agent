export interface ModalOptions {
  title: string;
  message: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
}

let overlay: HTMLElement | null = null;

function initOverlay(): void {
  if (overlay) return;

  overlay = document.createElement("div");
  overlay.id = "cy-modal-overlay";
  overlay.className = "cy-modal-overlay is-hidden";
  overlay.innerHTML = [
    '<div class="cy-modal" role="alertdialog" aria-modal="true">',
    '  <div class="cy-modal__head">',
    '    <span class="cy-modal__icon" id="cy-modal-icon">\u{1F4CC}</span>',
    '    <h3 class="cy-modal__title" id="cy-modal-title">\u63D0\u793A</h3>',
    '  </div>',
    '  <p class="cy-modal__body" id="cy-modal-message">\u786E\u8BA4\u6267\u884C\u6B64\u64CD\u4F5C\u5417\uFF1F</p>',
    '  <div class="cy-modal__actions">',
    '    <button type="button" class="ghost-btn" id="cy-modal-cancel">\u53D6\u6D88</button>',
    '    <button type="button" class="btn-primary" id="cy-modal-confirm">\u786E\u5B9A</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  document.body.appendChild(overlay);
}

export function showModal(options: ModalOptions): Promise<boolean> {
  initOverlay();
  if (!overlay) return Promise.resolve(false);

  const iconEl = overlay.querySelector("#cy-modal-icon") as HTMLElement;
  const titleEl = overlay.querySelector("#cy-modal-title") as HTMLElement;
  const msgEl = overlay.querySelector("#cy-modal-message") as HTMLElement;
  const cancelBtn = overlay.querySelector("#cy-modal-cancel") as HTMLButtonElement;
  const confirmBtn = overlay.querySelector("#cy-modal-confirm") as HTMLButtonElement;

  iconEl.textContent = options.icon || "\u{1F4CC}";
  titleEl.textContent = options.title;
  msgEl.textContent = options.message;
  cancelBtn.textContent = options.cancelText || "\u53D6\u6D88";
  confirmBtn.textContent = options.confirmText || "\u786E\u5B9A";

  overlay.classList.remove("is-hidden");

  return new Promise((resolve) => {
    const cleanup = (result: boolean) => {
      overlay?.classList.add("is-hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      resolve(result);
    };
    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}