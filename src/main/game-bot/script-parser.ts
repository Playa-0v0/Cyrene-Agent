// script-parser —— YAML 文本 → GameRecipe 解析 + 校驗。
// 純函數模塊，不依賴 electron，便於單測。校驗失敗返回 {ok:false,error}。

import * as yaml from "js-yaml";
import type { GameRecipe, Step } from "./types";

export type ParseResult = { ok: true; recipe: GameRecipe } | { ok: false; error: string };

/** 時長 → 毫秒：數字當 ms；"60s"→60000；"250ms"→250；"500"→500。非法拋錯。 */
function parseDuration(val: unknown, field: string): number {
  if (typeof val === "number" && Number.isFinite(val)) return Math.round(val);
  if (typeof val === "string") {
    const m = val.trim().match(/^(\d+)(s|ms)?$/);
    if (!m) throw new Error(field + " 時長格式非法: " + val);
    const n = parseInt(m[1], 10);
    return m[2] === "s" ? n * 1000 : n;
  }
  throw new Error(field + " 時長必須是數字或字符串");
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(field + " 必須是非空字符串");
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function optDur(v: unknown, field: string): number | undefined {
  return v === undefined ? undefined : parseDuration(v, field);
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 解析單個步驟（YAML 單鍵對象 {opName: params}）→ Step。校驗失敗拋錯。
 * branch.then/else 遞歸調用 parseStep。
 */
function parseStep(raw: unknown): Step {
  if (!raw || typeof raw !== "object") throw new Error("步驟必須是對象");
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) throw new Error("步驟必須只有一個原語鍵，實際: " + keys.join(","));
  const op = keys[0];
  const params = obj[op];

  switch (op) {
    case "launch":
      return { type: "launch", exe: str(params, "launch.exe") };
    case "yaagl_start":
      return { type: "yaagl_start" };
    case "wait":
      return { type: "wait", ms: parseDuration(params, "wait") };
    case "key":
      return { type: "key", combo: str(params, "key") };
    case "click": {
      if (params === "center") return { type: "click", target: "center" };
      if (params && typeof params === "object") {
        const p = params as { x?: unknown; y?: unknown; ratio_x?: unknown; ratio_y?: unknown };
        if (typeof p.ratio_x === "number" && typeof p.ratio_y === "number") {
          if (p.ratio_x < 0 || p.ratio_x > 1 || p.ratio_y < 0 || p.ratio_y > 1)
            throw new Error("click 比例座標必須在 0 到 1 之間");
          return { type: "click", target: { ratioX: p.ratio_x, ratioY: p.ratio_y } };
        }
        if (typeof p.x !== "number" || typeof p.y !== "number")
          throw new Error("click 座標必須是 {x,y} 或 {ratio_x,ratio_y} 數字");
        return { type: "click", target: { x: p.x, y: p.y } };
      }
      throw new Error("click 必須是 center、{x,y} 或 {ratio_x,ratio_y}");
    }
    case "vlm_click": {
      const p = (params ?? {}) as Record<string, unknown>;
      return {
        type: "vlm_click",
        ref: str(p.ref, "vlm_click.ref"),
        retry: optNum(p.retry) ?? 2,
        repeat: optNum(p.repeat) ?? 1,
        interval: optDur(p.interval, "vlm_click.interval") ?? 1000,
        settle: optDur(p.settle, "vlm_click.settle"),
        target: optStr(p.target),
      };
    }
    case "vlm_select": {
      if (typeof params === "string") {
        return { type: "vlm_select", desc: str(params, "vlm_select.desc"), retry: 2 };
      }
      const p = (params ?? {}) as Record<string, unknown>;
      return {
        type: "vlm_select",
        desc: str(p.desc, "vlm_select.desc"),
        retry: optNum(p.retry) ?? 2,
        settle: optDur(p.settle, "vlm_select.settle"),
      };
    }
    case "vlm_check": {
      const p = (params ?? {}) as Record<string, unknown>;
      return {
        type: "vlm_check",
        id: str(p.id, "vlm_check.id"),
        ask: str(p.ask, "vlm_check.ask"),
        ref: optStr(p.ref),
        settle: optDur(p.settle, "vlm_check.settle"),
      };
    }
    case "vlm_compare": {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!Array.isArray(p.refs)) throw new Error("vlm_compare.refs 必須是數組");
      return {
        type: "vlm_compare",
        id: str(p.id, "vlm_compare.id"),
        ask: str(p.ask, "vlm_compare.ask"),
        refs: p.refs.map(String),
        settle: optDur(p.settle, "vlm_compare.settle"),
      };
    }
    case "branch": {
      const p = (params ?? {}) as Record<string, unknown>;
      if (!Array.isArray(p.then)) throw new Error("branch.then 必須是步驟數組");
      const then = p.then.map(parseStep);
      const els = Array.isArray(p.else) ? p.else.map(parseStep) : undefined;
      return { type: "branch", if: str(p.if, "branch.if"), then, else: els };
    }
    default:
      throw new Error("未知原語: " + op);
  }
}

export function parseRecipe(yamlText: string): ParseResult {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText);
  } catch (err) {
    return { ok: false, error: "YAML 解析失敗: " + (err instanceof Error ? err.message : String(err)) };
  }
  if (!doc || typeof doc !== "object") return { ok: false, error: "腳本根必須是對象" };
  const d = doc as Record<string, unknown>;
  try {
    const name = str(d.name, "name");
    const exe = str(d.exe, "exe");
    const model = optStr(d.model);
    if (!Array.isArray(d.steps)) throw new Error("steps 必須是數組");
    const steps = d.steps.map(parseStep);
    return { ok: true, recipe: { name, exe, model, steps } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
