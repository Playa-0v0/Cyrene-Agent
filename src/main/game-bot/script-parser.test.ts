// script-parser 單測 —— YAML 文本 → GameRecipe 解析 + 校驗。
import { describe, it, expect } from "vitest";
import { parseRecipe } from "./script-parser";

describe("parseRecipe", () => {
  it("vlm_select 支援帶 retry/settle 的對象格式", () => {
    const result = parseRecipe('name: x\nexe: y\nsteps:\n  - vlm_select: { desc: "開始遊戲", retry: 4, settle: 2s }');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe.steps[0]).toEqual({
        type: "vlm_select",
        desc: "開始遊戲",
        retry: 4,
        settle: 2000,
      });
    }
  });

  it("click 支援 0 到 1 的螢幕比例座標", () => {
    const result = parseRecipe('name: x\nexe: y\nsteps:\n  - click: { ratio_x: 0.8, ratio_y: 0.86 }');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe.steps[0]).toEqual({ type: "click", target: { ratioX: 0.8, ratioY: 0.86 } });
    }
  });
  it("解析合法完整腳本（含所有原語 + branch 嵌套）", () => {
    const yaml = [
      'name: star-rail-daily',
      'exe: "${exe_path}"',
      'model: "${vlm_config}"',
      'steps:',
      '  - launch: "${exe}"',
      '  - wait: 60s',
      '  - key: F4',
      '  - click: center',
      '  - vlm_click: { ref: download_btn, repeat: 3, interval: 1s }',
      '  - vlm_select: "支援列表第一個"',
      '  - vlm_check: { id: has_update, ask: "有更新彈窗嗎？" }',
      '  - vlm_compare: { id: st, ask: "匹配哪個", refs: [a, b] }',
      '  - branch:',
      '      if: "${has_update}"',
      '      then:',
      '        - click: center',
      '      else:',
      '        - key: ESC',
    ].join("\n");
    const r = parseRecipe(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.name).toBe("star-rail-daily");
    expect(r.recipe.steps).toHaveLength(9);
    expect(r.recipe.steps[0]).toEqual({ type: "launch", exe: "${exe}" });
    expect(r.recipe.steps[1]).toEqual({ type: "wait", ms: 60000 });
    expect(r.recipe.steps[2]).toEqual({ type: "key", combo: "F4" });
    expect(r.recipe.steps[3]).toEqual({ type: "click", target: "center" });
    expect(r.recipe.steps[4]).toEqual({
      type: "vlm_click", ref: "download_btn", repeat: 3, interval: 1000, retry: 2,
    });
    expect(r.recipe.steps[5]).toEqual({
      type: "vlm_select", desc: "支援列表第一個", retry: 2,
    });
    expect(r.recipe.steps[6]).toEqual({
      type: "vlm_check", id: "has_update", ask: "有更新彈窗嗎？",
    });
    expect(r.recipe.steps[7]).toEqual({
      type: "vlm_compare", id: "st", ask: "匹配哪個", refs: ["a", "b"],
    });
    const br = r.recipe.steps[8];
    expect(br.type).toBe("branch");
    if (br.type === "branch") {
      expect(br.if).toBe("${has_update}");
      expect(br.then).toEqual([{ type: "click", target: "center" }]);
      expect(br.else).toEqual([{ type: "key", combo: "ESC" }]);
    }
  });

  it("缺 name 報錯", () => {
    const r = parseRecipe("exe: x\nsteps: []");
    expect(r.ok).toBe(false);
  });

  it("缺 steps 報錯", () => {
    const r = parseRecipe("name: x\nexe: y");
    expect(r.ok).toBe(false);
  });

  it("未知原語報錯", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - unknown_op: foo");
    expect(r.ok).toBe(false);
  });

  it("wait 純數字當 ms", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - wait: 500");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.steps[0]).toEqual({ type: "wait", ms: 500 });
  });

  it("wait ms 單位", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - wait: 250ms");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.steps[0]).toEqual({ type: "wait", ms: 250 });
  });

  it("click 座標形式", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - click: { x: 100, y: 200 }");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.steps[0]).toEqual({ type: "click", target: { x: 100, y: 200 } });
  });

  it("vlm_check 缺 id 報錯", () => {
    const r = parseRecipe('name: x\nexe: y\nsteps:\n  - vlm_check: { ask: "有嗎" }');
    expect(r.ok).toBe(false);
  });

  it("非法 YAML 報錯", () => {
    const r = parseRecipe("name: x\n  bad: : :");
    expect(r.ok).toBe(false);
  });
});
