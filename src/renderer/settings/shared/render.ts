// 通用列表渲染：空态 + 信息列表
// 从 settings.ts 抽离。依赖 escapeHtml（./format）。

import { escapeHtml } from "./format";

export function renderEmptyState(container: HTMLElement | null, title: string, hint: string): void {
  if (!container) return;
  container.innerHTML = [
    '<div class="memory-list__empty">',
    '  <span>📭</span>',
    `  <p>${escapeHtml(title)}</p>`,
    `  <p class="memory-list__hint">${escapeHtml(hint)}</p>`,
    '</div>',
  ].join("\n");
}

export function renderInfoList(
  container: HTMLElement | null,
  items: Array<{ title: string; body: string; meta?: string }>,
  emptyTitle: string,
  emptyHint: string,
): void {
  if (!container) return;
  if (items.length === 0) {
    renderEmptyState(container, emptyTitle, emptyHint);
    return;
  }

  container.innerHTML = items
    .map((item) => {
      const meta = item.meta ? `<p class="memory-record__meta">${escapeHtml(item.meta)}</p>` : "";
      return [
        '<article class="memory-record">',
        `  <h3 class="memory-record__title">${escapeHtml(item.title)}</h3>`,
        `  <p class="memory-record__body">${escapeHtml(item.body)}</p>`,
        `  ${meta}`,
        '</article>',
      ].join("\n");
    })
    .join("\n");
}
