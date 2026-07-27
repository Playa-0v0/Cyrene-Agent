// engine —— 步驟解釋器。逐原語執行 GameRecipe，支持 branch/變量/settle/retry。
// 核心純邏輯：通過 BotTools 接口調用工具（依賴注入），不直接 import screenshot/input/vlm，
// 因此可用 mock BotTools 單測。settle/sleep 也走注入，便於 fake timer。

import type { GameRecipe, Step } from "./types";
import type { BotTools, ProgressCb } from "./bot-tools";

export interface RunContext {
  tools: BotTools;
  vars?: Record<string, string>;      // 注入變量（exe_path / vlm_config 等）
  settleMs?: number;                   // vlm_* 截圖前等待，默認 3000
  sleep?: (ms: number) => Promise<void>;
  onProgress?: ProgressCb;
  signal?: { aborted: boolean };       // 中止信號：true 則在當前步驟後停止
}

export interface RunResult {
  ok: boolean;
  error?: string;
  completed: number;
  total: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 替換 ${var} 為 vars 中的值。 */
function resolveVars(s: string, vars: Record<string, unknown>): string {
  return s.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined ? "" : String(v);
  });
}

/**
 * 求 branch.if 表達式 → 布爾。
 * 支持 "${var}" / "${var == 'val'}" / "${var == 1}" / 裸 true/false。
 */
function evalExpr(expr: string, vars: Record<string, unknown>): boolean {
  const m = expr.trim().match(/^\$\{(\w+)\s*(?:==\s*(.+?))?\}$/);
  if (!m) {
    const r = resolveVars(expr, vars).trim().toLowerCase();
    return r === "true" || r === "1";
  }
  const name = m[1];
  const rhs = m[2];
  const val = vars[name];
  if (rhs === undefined) {
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    const s = String(val ?? "").trim().toLowerCase();
    return s === "true" || s === "1";
  }
  let r = rhs.trim();
  if ((r.startsWith("'") && r.endsWith("'")) || (r.startsWith('"') && r.endsWith('"'))) r = r.slice(1, -1);
  return String(val ?? "") === r;
}

function stepDesc(step: Step): string {
  switch (step.type) {
    case "launch": return "啟動 " + step.exe;
    case "yaagl_start": return "點擊 YAAGL 開始遊戲";
    case "wait": return "等待 " + step.ms + "ms";
    case "key": return "按鍵 " + step.combo;
    case "click": return "點擊 " + (step.target === "center" ? "中心" : JSON.stringify(step.target));
    case "vlm_click": return "識圖點擊 " + step.ref;
    case "vlm_select": return "語義選擇 " + step.desc;
    case "vlm_check": return "判斷 " + step.id;
    case "vlm_compare": return "比對 " + step.id;
    case "branch": return "分支 " + step.if;
  }
}

export async function runRecipe(recipe: GameRecipe, ctx: RunContext): Promise<RunResult> {
  const tools = ctx.tools;
  const vars: Record<string, unknown> = { ...(ctx.vars ?? {}) };
  // 腳本步驟可用 ${exe} / ${model} 引用頂層欄位；頂層欄位本身也可引用
  // 執行環境注入的 ${exe_path} / ${vlm_config}。
  vars.exe = resolveVars(recipe.exe, vars);
  if (recipe.model) vars.model = resolveVars(recipe.model, vars);
  const sleep = ctx.sleep ?? defaultSleep;
  const settleMs = ctx.settleMs ?? 3000;
  const total = recipe.steps.length;
  let completed = 0;

  async function execStep(step: Step): Promise<string | null> {
    if (ctx.signal?.aborted) return "已中止";
    switch (step.type) {
      case "launch":
        await tools.launch(resolveVars(step.exe, vars));
        return null;
      case "yaagl_start":
        await tools.yaaglStart();
        return null;
      case "wait":
        await sleep(step.ms);
        return null;
      case "key":
        await tools.key(step.combo);
        return null;
      case "click":
        if (step.target === "center") await tools.clickCenter();
        else if ("ratioX" in step.target) {
          const shot = await tools.screenshot();
          if (!shot) return "無法取得螢幕尺寸以計算比例點擊";
          await tools.click(
            Math.round(shot.width * step.target.ratioX),
            Math.round(shot.height * step.target.ratioY),
          );
        } else await tools.click(step.target.x, step.target.y);
        return null;
      case "vlm_click": {
        await sleep(step.settle ?? settleMs);
        const tries = (step.retry ?? 2) + 1;
        let coord: { x: number; y: number } | null = null;
        for (let i = 0; i < tries; i++) {
          if (ctx.signal?.aborted) return "已中止";
          coord = await tools.locate(step.ref, step.target);
          if (coord) break;
          if (i < tries - 1) await sleep(1000);
        }
        if (!coord) return "vlm_click 定位失敗: " + step.ref;
        const repeat = step.repeat ?? 1;
        for (let r = 0; r < repeat; r++) {
          await tools.click(coord.x, coord.y);
          if (r < repeat - 1) await sleep(step.interval ?? 1000);
        }
        return null;
      }
      case "vlm_select": {
        await sleep(step.settle ?? settleMs);
        const tries = (step.retry ?? 2) + 1;
        let coord: { x: number; y: number } | null = null;
        for (let i = 0; i < tries; i++) {
          if (ctx.signal?.aborted) return "已中止";
          coord = await tools.select(step.desc);
          if (coord) break;
          if (i < tries - 1) await sleep(1000);
        }
        if (!coord) return "vlm_select 定位失敗: " + step.desc;
        await tools.click(coord.x, coord.y);
        return null;
      }
      case "vlm_check": {
        await sleep(step.settle ?? settleMs);
        let ans: boolean | null = null;
        for (let i = 0; i < 3; i++) {
          ans = await tools.check(step.ask, step.ref);
          if (ans !== null) break;
          if (i < 2) await sleep(1000);
        }
        vars[step.id] = ans ?? false;
        return null;
      }
      case "vlm_compare": {
        await sleep(step.settle ?? settleMs);
        let idx: number | null = null;
        for (let i = 0; i < 3; i++) {
          idx = await tools.compare(step.refs, step.ask);
          if (idx !== null) break;
          if (i < 2) await sleep(1000);
        }
        vars[step.id] = idx ?? 0;
        return null;
      }
      case "branch": {
        const cond = evalExpr(step.if, vars);
        const branchSteps = cond ? step.then : (step.else ?? []);
        for (const sub of branchSteps) {
          if (ctx.signal?.aborted) return "已中止";
          const err = await execStep(sub);
          if (err) return err;
        }
        return null;
      }
    }
  }

  for (let i = 0; i < recipe.steps.length; i++) {
    if (ctx.signal?.aborted) return { ok: false, error: "已中止", completed, total };
    const step = recipe.steps[i];
    ctx.onProgress?.({ index: i, total, desc: stepDesc(step) });
    const err = await execStep(step);
    if (err) return { ok: false, error: err, completed, total };
    completed = i + 1;
  }
  return { ok: true, completed, total };
}
