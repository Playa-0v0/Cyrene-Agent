// Plugins 面板业务逻辑：天气 / 出行 / 内置 MCP 开关的配置加载 / 保存 / 事件绑定
// 从 settings.ts 抽离。依赖 plugins DOM 引用（./dom）、pluginsState（./state，防抖 timer）。
// 副作用导入：模块加载时执行事件绑定 + 初始加载。

import {
  weatherEnabledCheckbox, weatherConfig, weatherSourceSelect, amapFields, amapKeyInput,
  travelEnabledCheckbox, travelConfig, travelAmapKeyInput,
  playwrightMcpCheckbox,
} from "./dom";
import { pluginsState } from "./state";

// ===== 天气插件（Open-Meteo / 高德天气） =====

export function syncWeatherConfigVisibility(): void {
  if (weatherConfig) weatherConfig.style.display = weatherEnabledCheckbox?.checked ? "block" : "none";
  syncWeatherFieldsVisibility();
}

export function syncWeatherFieldsVisibility(): void {
  const src = weatherSourceSelect?.value ?? "open-meteo";
  // 选高德才显示高德 Key 输入框
  if (amapFields) amapFields.style.display = src === "amap" ? "block" : "none";
}

export async function saveWeatherField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存天气配置失败:", field, err);
  }
}

export async function loadWeatherConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && weatherEnabledCheckbox) {
      weatherEnabledCheckbox.checked = Boolean(cfg.weatherEnabled);
    }
    if (cfg && weatherSourceSelect) {
      weatherSourceSelect.value = cfg.weatherSource === "amap" ? "amap" : "open-meteo";
    }
    if (cfg && amapKeyInput) {
      amapKeyInput.value = String(cfg.amapKey ?? "");
    }
    syncWeatherConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加载天气配置失败", err);
  }
}

// ===== 出行工具 =====

export function syncTravelConfigVisibility(): void {
  if (travelConfig) travelConfig.style.display = travelEnabledCheckbox?.checked ? "block" : "none";
}

export async function saveTravelField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存出行配置失败:", field, err);
  }
}

export async function loadTravelConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && travelEnabledCheckbox) {
      travelEnabledCheckbox.checked = Boolean(cfg.travelEnabled);
    }
    if (cfg && travelAmapKeyInput) {
      travelAmapKeyInput.value = String(cfg.amapKey ?? "");
    }
    syncTravelConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加载出行配置失败", err);
  }
}

// ===== 内置 MCP 工具开关 =====
// Playwright MCP（浏览器自动化）通过 playwrightMcpEnabled 控制，
// main 端的 syncPlaywrightMcp() 会监听字段变化自动注册 / 移除 MCP server。

export async function saveBuiltinMcpField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn(`[settings] 保存 ${field} 失败:`, err);
  }
}

export async function loadBuiltinMcpToggles(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && playwrightMcpCheckbox) {
      // 默认关闭 —— 浏览器走系统 Edge，MCP 随应用内置，无需额外下载
      playwrightMcpCheckbox.checked = Boolean(cfg.playwrightMcpEnabled);
    }
  } catch (err) {
    console.warn("[settings] 加载内置 MCP 开关失败", err);
  }
}

// ===== 事件绑定（模块加载时执行） =====
weatherEnabledCheckbox?.addEventListener("change", () => {
  syncWeatherConfigVisibility();
  void saveWeatherField("weatherEnabled", weatherEnabledCheckbox.checked);
});
weatherSourceSelect?.addEventListener("change", () => {
  syncWeatherFieldsVisibility();
  void saveWeatherField("weatherSource", weatherSourceSelect.value);
});
amapKeyInput?.addEventListener("change", () => {
  void saveWeatherField("amapKey", amapKeyInput.value.trim());
});
// 防抖保存：粘贴后 800ms 自动保存
amapKeyInput?.addEventListener("input", () => {
  clearTimeout(pluginsState.amapKeyDebounceTimer);
  pluginsState.amapKeyDebounceTimer = setTimeout(() => {
    void saveWeatherField("amapKey", amapKeyInput.value.trim());
  }, 800);
});

travelEnabledCheckbox?.addEventListener("change", () => {
  syncTravelConfigVisibility();
  void saveTravelField("travelEnabled", travelEnabledCheckbox.checked);
});
travelAmapKeyInput?.addEventListener("change", () => {
  // 存到同一个 amapKey 字段（与天气查询共用）
  void saveTravelField("amapKey", travelAmapKeyInput.value.trim());
});
// 防抖保存：粘贴后 800ms 自动保存
travelAmapKeyInput?.addEventListener("input", () => {
  clearTimeout(pluginsState.travelAmapKeyDebounceTimer);
  pluginsState.travelAmapKeyDebounceTimer = setTimeout(() => {
    void saveTravelField("amapKey", travelAmapKeyInput.value.trim());
  }, 800);
});

playwrightMcpCheckbox?.addEventListener("change", () => {
  void saveBuiltinMcpField("playwrightMcpEnabled", playwrightMcpCheckbox.checked);
});

// 模块加载时拉一次配置
void loadWeatherConfig();
void loadTravelConfig();
void loadBuiltinMcpToggles();
