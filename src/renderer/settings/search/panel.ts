// Search 面板业务逻辑：配置加载 / 保存 / 引擎行可见性同步
// 从 settings.ts 抽离。依赖 search DOM 引用（./dom）。
// 多引擎配置：博查 / Tavily / 火山(MiniMax) / AnySearch，按 searchEngine 切换显示对应 key 输入行。

import {
  searchEnabledCheckbox, searchConfig, searchEngineSelect,
  searchBochaKeyInput, searchTavilyKeyInput, searchMinimaxKeyInput, searchAnySearchKeyInput,
  searchBochaRow, searchTavilyRow, searchMinimaxRow, searchAnySearchRow,
} from "./dom";

const SEARCH_ROW_MAP: Record<string, HTMLElement | null> = {
  bocha: searchBochaRow,
  tavily: searchTavilyRow,
  minimax: searchMinimaxRow,
  anySearch: searchAnySearchRow,
};

const SEARCH_KEY_INPUT_MAP: Record<string, HTMLInputElement | null> = {
  bocha: searchBochaKeyInput,
  tavily: searchTavilyKeyInput,
  minimax: searchMinimaxKeyInput,
  anySearch: searchAnySearchKeyInput,
};

const SEARCH_KEY_FIELD_MAP: Record<string, string> = {
  bocha: "searchBochaKey",
  tavily: "searchTavilyKey",
  minimax: "searchMinimaxKey",
  anySearch: "searchAnySearchKey",
};

export function syncSearchConfigVisibility(): void {
  if (searchConfig) searchConfig.style.display = searchEnabledCheckbox?.checked ? "block" : "none";
  syncSearchEngineRows();
}

export function syncSearchEngineRows(): void {
  const engine = searchEngineSelect?.value ?? "off";
  for (const [key, row] of Object.entries(SEARCH_ROW_MAP)) {
    if (row) row.style.display = key === engine ? "flex" : "none";
  }
}

export async function saveSearchField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存搜索配置失败:", field, err);
  }
}

export async function loadSearchConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (!cfg) return;
    const engine = String(cfg.searchEngine ?? "off");
    if (searchEngineSelect) searchEngineSelect.value = engine;
    if (searchBochaKeyInput) searchBochaKeyInput.value = String(cfg.searchBochaKey ?? "");
    if (searchTavilyKeyInput) searchTavilyKeyInput.value = String(cfg.searchTavilyKey ?? "");
    if (searchMinimaxKeyInput) searchMinimaxKeyInput.value = String(cfg.searchMinimaxKey ?? "");
    if (searchAnySearchKeyInput) searchAnySearchKeyInput.value = String(cfg.searchAnySearchKey ?? "");
    // 开关状态：engine 不是 off 就算启用
    if (searchEnabledCheckbox) searchEnabledCheckbox.checked = engine !== "off";
    syncSearchConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加载搜索配置失败", err);
  }
}

// ===== 事件绑定（模块加载时执行） =====
searchEnabledCheckbox?.addEventListener("change", () => {
  syncSearchConfigVisibility();
  // 开关变化时，若开启则把 searchEngine 从 off 改成第一个有 key 的源（或 bocha）
  if (searchEnabledCheckbox.checked && searchEngineSelect?.value === "off") {
    searchEngineSelect.value = "bocha";
    syncSearchEngineRows();
    void saveSearchField("searchEngine", "bocha");
  } else {
    void saveSearchField("searchEngine", searchEngineSelect?.value ?? "off");
  }
});

searchEngineSelect?.addEventListener("change", () => {
  syncSearchEngineRows();
  void saveSearchField("searchEngine", searchEngineSelect.value);
});

// 各源 key 输入：失焦保存 + 输入时防抖保存（防粘贴后未失焦就丢失）
const searchKeyDebounceTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
for (const [engine, input] of Object.entries(SEARCH_KEY_INPUT_MAP)) {
  if (!input) continue;
  const field = SEARCH_KEY_FIELD_MAP[engine];
  input.addEventListener("change", () => { void saveSearchField(field, input.value.trim()); });
  input.addEventListener("blur", () => { void saveSearchField(field, input.value.trim()); });
  // 输入时防抖保存：粘贴或打字后 800ms 自动保存，不依赖失焦
  input.addEventListener("input", () => {
    clearTimeout(searchKeyDebounceTimers[engine]);
    searchKeyDebounceTimers[engine] = setTimeout(() => {
      void saveSearchField(field, input.value.trim());
    }, 800);
  });
}

// 模块加载时拉一次配置
void loadSearchConfig();
