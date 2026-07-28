// Chat 窗口推理下拉 —— 按 (providerId, model) capability 动态生成选项。
//
// 入口：computeReasoningDropdown(providerId, model, savedPreference)
// 返回 ReasoningDropdownView，由 chat/main.ts 在真实 DOM 上构建选项。
//
// 控件形态（按 capability.control）：
// - fixed-on：始终开启，控件 disabled，单项 disabled
// - dynamic：跟随动态路由，控件 disabled，单项 disabled
// - none：未配置推理控制，控件 disabled，单项 disabled
// - toggle（无 supportedEfforts）：跟随模型 / [关闭] / 开启
// - effort / toggle-effort（带 supportedEfforts）：跟随模型 / [关闭] / supportedEfforts.map
//
// 注意：effective 必须用 resolveEffectiveReasoning(saved, capability) 计算，
// 不能直接 saved ?? auto。原因：fixed-on 模型即使 saved=off，effective.mode 仍为 on；
// saved.effort 不被支持时 effective.effort 应退回 defaultEffort。

import {
  resolveEffectiveReasoning,
  resolveReasoningCapability,
  type ReasoningEffort,
  type ReasoningPreference,
} from "../../shared/reasoning";

export interface ReasoningDropdownItem {
  label: string;
  preference: ReasoningPreference;
  /** 该 item 不可点击（fixed-on / dynamic / none 的唯一项） */
  disabled?: boolean;
  /** tooltip 提示 */
  hint?: string;
}

export interface ReasoningDropdownView {
  /** 整个下拉禁用（fixed-on / dynamic / none）：trigger 也不可点 */
  disabled: boolean;
  /** 触发按钮上显示的文案（用户当前 effective 状态） */
  statusText: string;
  /** 当前选中的 item preference（与 saved 可能不同——saved 是用户偏好，effective 是能力归一化后的值） */
  activePreference: ReasoningPreference;
  items: ReasoningDropdownItem[];
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最强",
};

export function computeReasoningDropdown(
  providerId: string,
  model: string,
  saved: ReasoningPreference | undefined,
  thinkingOverride?: -1 | 0 | 1,
): ReasoningDropdownView {
  const cap = resolveReasoningCapability(providerId, model);
  // 用户修正 #2：必须用 resolveEffectiveReasoning，不能 saved ?? auto
  const effective = resolveEffectiveReasoning(saved, cap, thinkingOverride);

  if (thinkingOverride === 1) {
    const items: ReasoningDropdownItem[] = [
      { label: "跟随模型", preference: { mode: "auto" } },
    ];
    items.push({ label: "关闭", preference: { mode: "off" } });
    items.push({ label: "开启", preference: { mode: "on" } });
    return {
      disabled: false,
      statusText: statusTextFor(effective),
      activePreference: effective,
      items,
    };
  } else if (thinkingOverride === -1) {
    return {
      disabled: true,
      statusText: "跟随模型",
      activePreference: effective,
      items: [
        {
          label: "跟随模型",
          preference: { mode: "auto" },
          disabled: true,
          hint: "当前模型未配置推理控制",
        },
      ],
    };
  }

  // ── fixed-on：始终开启，控件整体禁用，单项 disabled ──
  if (cap.control === "fixed-on") {
    return {
      disabled: true,
      statusText: "始终开启",
      activePreference: effective,
      items: [
        {
          label: "始终开启",
          preference: { mode: "on" },
          disabled: true,
          hint: "该模型始终思考，无法关闭",
        },
      ],
    };
  }

  // ── dynamic：跟随动态路由，控件整体禁用 ──
  if (cap.control === "dynamic") {
    return {
      disabled: true,
      statusText: "跟随动态路由",
      activePreference: effective,
      items: [
        {
          label: "跟随动态路由",
          preference: { mode: "auto" },
          disabled: true,
          hint: "由火山动态路由决定",
        },
      ],
    };
  }

  // ── none：未配置推理控制，控件整体禁用 ──
  if (cap.control === "none") {
    return {
      disabled: true,
      statusText: "跟随模型",
      activePreference: effective,
      items: [
        {
          label: "跟随模型",
          preference: { mode: "auto" },
          disabled: true,
          hint: "当前模型未配置推理控制",
        },
      ],
    };
  }

  // ── toggle（无 supportedEfforts）：跟随 / [关闭] / 开启 ──
  if (cap.control === "toggle") {
    const items: ReasoningDropdownItem[] = [
      { label: "跟随模型", preference: { mode: "auto" } },
    ];
    if (cap.supportsDisable) {
      items.push({ label: "关闭", preference: { mode: "off" } });
    }
    items.push({ label: "开启", preference: { mode: "on" } });
    return {
      disabled: false,
      statusText: statusTextFor(effective),
      activePreference: effective,
      items,
    };
  }

  // ── effort / toggle-effort（带 supportedEfforts） ──
  const efforts = cap.supportedEfforts ?? [];
  const items: ReasoningDropdownItem[] = [
    { label: "跟随模型", preference: { mode: "auto" } },
  ];
  if (cap.supportsDisable) {
    items.push({ label: "关闭", preference: { mode: "off" } });
  }
  for (const e of efforts) {
    items.push({ label: EFFORT_LABEL[e], preference: { mode: "on", effort: e } });
  }
  return {
    disabled: false,
    statusText: statusTextFor(effective),
    activePreference: effective,
    items,
  };
}

function statusTextFor(effective: ReasoningPreference): string {
  if (effective.mode === "auto") return "跟随模型";
  if (effective.mode === "off") return "关闭";
  if (effective.effort) return EFFORT_LABEL[effective.effort];
  return "开启";
}

/** statusText 显示在下拉触发按钮上：前缀 "推理 · " */
export function formatReasoningTriggerLabel(statusText: string): string {
  return `推理 · ${statusText}`;
}