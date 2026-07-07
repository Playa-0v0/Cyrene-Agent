// Tool: play_live2d_action
//
// Registered with the existing toolRegistry so the LLM can ask Cyrene to
// perform a Live2D animation on herself. The handler validates the alias
// against the shared catalog and forwards the *resolved* target over IPC;
// the renderer never sees the raw alias, so it can never play something the
// catalog did not sanction.

import { LIVE2D_ACTIONS, findAction, type Live2DTarget } from "../../../shared/live2d-actions";
import { IPC } from "../../../shared/ipc-channels";
import type { ToolDefinition } from "../tool-registry";

export type PlayLive2DActionDeps = {
  /** Injected so we can unit-test without a real BrowserWindow. */
  sendToLive2DWindow: (channel: string, payload?: unknown) => void;
};

export type PlayLive2DActionResult =
  | { ok: true }
  | { ok: false; error: "unknown_action"; available: string[] }
  | { ok: false; error: "ipc_failed" };

/**
 * Build the handler. Returns a function compatible with
 * `ToolDefinition.execute`.
 */
export function createPlayLive2DActionHandler(deps: PlayLive2DActionDeps) {
  return async (
    args: Record<string, unknown>,
    _ctx?: unknown,
  ): Promise<PlayLive2DActionResult> => {
    const raw = args?.name;
    if (typeof raw !== "string" || raw.length === 0) {
      return {
        ok: false,
        error: "unknown_action",
        available: LIVE2D_ACTIONS.map((a) => a.alias),
      };
    }
    const action = findAction(raw);
    if (!action) {
      return {
        ok: false,
        error: "unknown_action",
        available: LIVE2D_ACTIONS.map((a) => a.alias),
      };
    }
    try {
      deps.sendToLive2DWindow(IPC.LIVE2D_PLAY_ACTION, action.target satisfies Live2DTarget);
      return { ok: true };
    } catch (err) {
      console.warn("[play-live2d-action] IPC failed:", err);
      return { ok: false, error: "ipc_failed" };
    }
  };
}

/** Build the description string from the catalog so adding an alias needs no prompt edits. */
function buildDescription(): string {
  const lines = LIVE2D_ACTIONS.map((a) => `- ${a.alias}（${a.description}）`).join("\n");
  return [
    "让 Cyrene 在 Live2D 模型上做一个动作（表情或肢体动作）。",
    "当用户让她做一个屏幕上可以做的动作时调用此工具。",
    "",
    "可选动作列表：",
    lines,
    "",
    "如果用户要的动作不在这个列表里，不要调用此工具 — 用文字告诉用户你能做什么，并（可选）推荐一个最接近的动作。",
    "参数：name（必填，从上面的列表中选一个中文别名）。",
  ].join("\n");
}

/** The fully wired ToolDefinition, ready for `toolRegistry.register()`. */
export function createPlayLive2DActionTool(deps: PlayLive2DActionDeps): ToolDefinition {
  return {
    id: "play_live2d_action",
    name: "做动作",
    description: buildDescription(),
    enabled: true,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "动作的中文别名，例如「眨眨眼」「戴墨镜」「笑一笑」",
        },
      },
      required: ["name"],
    },
    execute: createPlayLive2DActionHandler(deps) as unknown as ToolDefinition["execute"],
  };
}
