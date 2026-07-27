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

/** Serialize a structured result to the JSON string the tool contract requires. */
function toJsonResult(r: PlayLive2DActionResult): string {
  return JSON.stringify(r);
}

/**
 * Build the handler. Returns a function compatible with
 * `ToolDefinition.execute` (Promise<string>).
 */
export function createPlayLive2DActionHandler(deps: PlayLive2DActionDeps) {
  return async (
    args: Record<string, unknown>,
    _ctx?: unknown,
  ): Promise<string> => {
    const raw = args?.name;
    if (typeof raw !== "string" || raw.length === 0) {
      return toJsonResult({
        ok: false,
        error: "unknown_action",
        available: LIVE2D_ACTIONS.map((a) => a.alias),
      });
    }
    const action = findAction(raw);
    if (!action) {
      return toJsonResult({
        ok: false,
        error: "unknown_action",
        available: LIVE2D_ACTIONS.map((a) => a.alias),
      });
    }
    try {
      deps.sendToLive2DWindow(IPC.LIVE2D_PLAY_ACTION, action.target satisfies Live2DTarget);
      return toJsonResult({ ok: true });
    } catch (err) {
      console.warn("[play-live2d-action] IPC failed:", err);
      return toJsonResult({ ok: false, error: "ipc_failed" });
    }
  };
}

/** Build the description string from the catalog so adding an alias needs no prompt edits. */
function buildDescription(): string {
  const lines = LIVE2D_ACTIONS.map((a) => `- ${a.alias}（${a.description}）`).join("\n");
  return [
    "讓 Cyrene 在 Live2D 模型上做一個動作（表情或肢體動作）。",
    "當用戶讓她做一個屏幕上可以做的動作時調用此工具。",
    "",
    "可選動作列表：",
    lines,
    "",
    "如果用戶要的動作不在這個列表裡，不要調用此工具 — 用文字告訴用戶你能做什麼，並（可選）推薦一個最接近的動作。",
    "參數：name（必填，從上面的列表中選一箇中文別名）。",
  ].join("\n");
}

/** The fully wired ToolDefinition, ready for `toolRegistry.register()`. */
export function createPlayLive2DActionTool(deps: PlayLive2DActionDeps): ToolDefinition {
  return {
    id: "play_live2d_action",
    name: "做動作",
    description: buildDescription(),
    enabled: true,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "動作的中文別名，例如「眨眨眼」「戴墨鏡」「笑一笑」",
        },
      },
      required: ["name"],
    },
    execute: createPlayLive2DActionHandler(deps),
  };
}
