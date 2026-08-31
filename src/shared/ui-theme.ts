/** 当前仅维护白调主题；保留该类型和归一化函数用于兼容已有配置。 */
export type UiTheme = "pearl-white";

export function normalizeUiTheme(_value: unknown): UiTheme {
  return "pearl-white";
}
