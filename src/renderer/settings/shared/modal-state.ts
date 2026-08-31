// Modal 共享状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。
// 被 showModal/showHtmlModal/showInputModal 及其调用方共用。

export const modalState = {
  cyOverlay: null as HTMLElement | null,
  cyHtmlOverlay: null as HTMLElement | null,
  cyInputOverlay: null as HTMLElement | null,
};
