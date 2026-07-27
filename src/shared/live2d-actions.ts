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
    description: "恢復到默認姿態和表情",
    target: { kind: "motion", group: "動作#6", motionName: "動作回正" },
  },
  {
    alias: "眨眨眼",
    description: "俏皮地眨一隻眼睛",
    target: { kind: "motion", group: "動作#6", motionName: "Wink~" },
  },
  {
    alias: "可愛一下",
    description: "害羞地裝可愛",
    target: { kind: "motion", group: "動作#6", motionName: "我可愛吧~" },
  },
  {
    alias: "笑一笑",
    description: "對著用戶微笑",
    target: { kind: "motion", group: "動作#6", motionName: "笑一笑吧~" },
  },
  {
    alias: "戴墨鏡",
    description: "戴上墨鏡耍個帥",
    target: { kind: "expression", name: "墨鏡" },
  },
  {
    alias: "問號",
    description: "頭頂冒出一個問號",
    target: { kind: "expression", name: "問號" },
  },
  {
    alias: "閃閃發光",
    description: "身上閃出光芒",
    target: { kind: "expression", name: "閃耀" },
  },
  {
    alias: "星星眼",
    description: "眼睛變成星星形狀",
    target: { kind: "expression", name: "星星眼" },
  },
  {
    alias: "圈圈眼",
    description: "眼睛變成眩暈圈圈",
    target: { kind: "expression", name: "圈圈眼" },
  },
  {
    alias: "開心眼",
    description: "眼睛變成彎彎的笑眼",
    target: { kind: "expression", name: "開心眼" },
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