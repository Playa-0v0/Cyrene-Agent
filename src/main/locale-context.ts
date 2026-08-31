/**
 * Locale Context — 集中管理主进程的语言/地区配置。
 *
 * 第一阶段：把散落的 "zh-CN" / "zh" 硬编码统一到此处。
 * 默认行为全部保持中文不变。
 *
 * 不同语言概念分开管理，不能只做一个全局 locale：
 *   - uiLocale:        UI 按钮、提示文字（未来 i18n 用）
 *   - dateLocale:      日期时间格式化（BCP 47，如 zh-CN）
 *   - weatherLanguage:  天气/地理编码 API 的 language 参数（短码，如 zh/en）
 *   - responseLanguage: Agent 回复语言提示
 *   - memoryLanguage:   Memory 内容初始化语言
 *   - asrLanguage:      语音识别语言（短码，如 zh/en）
 */

export interface LocaleContext {
  uiLocale: string;
  dateLocale: string;
  weatherLanguage: string;
  responseLanguage: string;
  memoryLanguage: string;
  asrLanguage?: string;
}

// ── 语言映射 ──

/**
 * BCP 47 locale → 天气 API 短码。
 * 天气 API 通常只接受 zh/en/ja 等短码，不接受 zh-CN。
 */
function resolveWeatherLanguage(locale: string): string {
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  return "en";
}

/**
 * BCP 47 locale → ASR 短码。
 */
function resolveAsrLanguage(locale: string): string {
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return "en";
}

// ── 归一化 ──

/**
 * 归一化 locale 值：去除空白，验证非空。
 * 空字符串、非字符串、纯空白 → 回退默认值。
 */
function normalizeLocale(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// ── 默认值（中文） ──

const DEFAULT_LOCALE: LocaleContext = {
  uiLocale: "zh-CN",
  dateLocale: "zh-CN",
  weatherLanguage: "zh",
  responseLanguage: "zh-CN",
  memoryLanguage: "zh-CN",
  asrLanguage: "zh",
};

// ── 当前上下文 ──

let current: LocaleContext = { ...DEFAULT_LOCALE };

/**
 * 初始化或更新 Locale Context。
 * 通常在 GeneralSettings 加载或用户修改语言设置时调用。
 * 只更新传入的字段，未传入的保留当前值。
 * 派生字段（weatherLanguage、memoryLanguage）从 uiLocale 自动映射。
 */
export function updateLocaleContext(patch: Partial<LocaleContext>): void {
  if (patch.uiLocale !== undefined) {
    const ui = normalizeLocale(patch.uiLocale, DEFAULT_LOCALE.uiLocale);
    current.uiLocale = ui;
    // 派生：除非显式覆盖，否则从 uiLocale 映射
    if (patch.weatherLanguage === undefined) {
      current.weatherLanguage = resolveWeatherLanguage(ui);
    }
    if (patch.memoryLanguage === undefined) {
      current.memoryLanguage = ui;
    }
    if (patch.asrLanguage === undefined) {
      current.asrLanguage = resolveAsrLanguage(ui);
    }
  }

  if (patch.dateLocale !== undefined) {
    current.dateLocale = normalizeLocale(patch.dateLocale, DEFAULT_LOCALE.dateLocale);
  }
  if (patch.weatherLanguage !== undefined) {
    current.weatherLanguage = normalizeLocale(patch.weatherLanguage, DEFAULT_LOCALE.weatherLanguage);
  }
  if (patch.responseLanguage !== undefined) {
    current.responseLanguage = normalizeLocale(patch.responseLanguage, DEFAULT_LOCALE.responseLanguage);
  }
  if (patch.memoryLanguage !== undefined) {
    current.memoryLanguage = normalizeLocale(patch.memoryLanguage, DEFAULT_LOCALE.memoryLanguage);
  }
  if (patch.asrLanguage !== undefined) {
    current.asrLanguage = normalizeLocale(patch.asrLanguage, DEFAULT_LOCALE.asrLanguage ?? "zh");
  }
}

/**
 * 获取当前 Locale Context（只读快照）。
 */
export function getLocaleContext(): Readonly<LocaleContext> {
  return current;
}

// ── 便捷访问器 ──

/** 日期时间格式化用的 locale。 */
export function getDateLocale(): string {
  return current.dateLocale;
}

/** 天气/地理编码 API 的 language 参数。 */
export function getWeatherLanguage(): string {
  return current.weatherLanguage;
}

/** Memory 内容初始化语言。 */
export function getMemoryLanguage(): string {
  return current.memoryLanguage;
}

/** ASR 识别语言。 */
export function getAsrLanguage(): string | undefined {
  return current.asrLanguage;
}
