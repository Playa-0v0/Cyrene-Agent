// Preferences 面板 DOM 引用（Sticker 子区）
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const stickerEnabledInput = document.getElementById("sticker-enabled") as HTMLInputElement;
export const stickerSizeSelect = document.getElementById("sticker-size") as HTMLElement;
export const stickerThresholdInput = document.getElementById("sticker-threshold") as HTMLInputElement;
export const stickerThresholdVal = document.getElementById("sticker-threshold-val") as HTMLElement;
export const stickerAddOverlay = document.getElementById("sticker-add-overlay") as HTMLElement;
export const stickerAddPickBtn = document.getElementById("sticker-add-pick-btn") as HTMLButtonElement;
export const stickerAddFileName = document.getElementById("sticker-add-file-name") as HTMLElement;
export const stickerAddId = document.getElementById("sticker-add-id") as HTMLInputElement;
export const stickerAddDesc = document.getElementById("sticker-add-desc") as HTMLInputElement;
export const stickerAddPhrases = document.getElementById("sticker-add-phrases") as HTMLTextAreaElement;
export const stickerAddError = document.getElementById("sticker-add-error") as HTMLElement;
export const stickerAddConfirm = document.getElementById("sticker-add-confirm") as HTMLButtonElement;
export const stickerAddCancel = document.getElementById("sticker-add-cancel") as HTMLButtonElement;
