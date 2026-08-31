// Live2D action catalog — single source of truth for every alias Cyrene
// can perform on her Live2D model. Consumed by:
//   - Main process: build the play_live2d_action tool description, validate
//     LLM tool calls before forwarding.
//   - Renderer: map an incoming `Live2DTarget` to motion()/expression() calls.
//
// Adding a new alias = appending one entry here. No prompt edits required —
// the tool description is generated from this list at registration time.

export type Live2DTarget =
  | { kind: "motion"; group: string; motionName: string }
  | { kind: "expression"; name: string };

export interface Live2DAction {
  /** Chinese name exposed to the LLM. Unique within the catalog (case-insensitive). */
  alias: string;
  /** One-line hint shown to the LLM alongside the alias. */
  description: string;
  /** Concrete target the renderer dispatches. */
  target: Live2DTarget;
}

export const LIVE2D_ACTIONS: readonly Live2DAction[] = [
  {
    alias: "回正",
    description: "恢复到默认姿态和表情",
    target: { kind: "motion", group: "动作#6", motionName: "动作回正" },
  },
  {
    alias: "眨眨眼",
    description: "俏皮地眨一只眼睛",
    target: { kind: "motion", group: "动作#6", motionName: "Wink~" },
  },
  {
    alias: "可爱一下",
    description: "害羞地装可爱",
    target: { kind: "motion", group: "动作#6", motionName: "我可爱吧~" },
  },
  {
    alias: "笑一笑",
    description: "对着用户微笑",
    target: { kind: "motion", group: "动作#6", motionName: "笑一笑吧~" },
  },
  {
    alias: "戴墨镜",
    description: "戴上墨镜耍个帅",
    target: { kind: "expression", name: "墨镜" },
  },
  {
    alias: "问号",
    description: "头顶冒出一个问号",
    target: { kind: "expression", name: "问号" },
  },
  {
    alias: "闪闪发光",
    description: "身上闪出光芒",
    target: { kind: "expression", name: "闪耀" },
  },
  {
    alias: "星星眼",
    description: "眼睛变成星星形状",
    target: { kind: "expression", name: "星星眼" },
  },
  {
    alias: "圈圈眼",
    description: "眼睛变成眩晕圈圈",
    target: { kind: "expression", name: "圈圈眼" },
  },
  {
    alias: "开心眼",
    description: "眼睛变成弯弯的笑眼",
    target: { kind: "expression", name: "开心眼" },
  },
];

/**
 * Look up an action by its alias. Case-insensitive. Returns undefined for
 * unknown or empty input. Both Main (tool handler validation) and Renderer
 * (alias→target resolution) call this; it never throws.
 */
export function findAction(alias: string): Live2DAction | undefined {
  if (!alias) return undefined;
  const needle = alias.trim().toLowerCase();
  if (!needle) return undefined;
  return LIVE2D_ACTIONS.find((a) => a.alias.toLowerCase() === needle);
}