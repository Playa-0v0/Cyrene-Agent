// Tool: wuwa_task
// 鳴潮 (ok-ww) 自動化腳本控制工具 — 讓 Cyrene (昔漣) 能列出、啟動及自動排隊執行 ok-ww 任務。

import { spawn } from "child_process";
import EventEmitter from "events";
import fs from "fs";
import path from "path";
import type { ToolDefinition } from "../tool-registry";
import type { ToolContext } from "../tool-context";

export interface WuwaTaskItem {
  index: number;
  name: string;
  taskClass: string;
  description: string;
}

export const WUWA_TASKS: WuwaTaskItem[] = [
  { index: 1, name: "每日任務", taskClass: "DailyTask", description: "登入、領月卡、刷聲骸與領每日獎勵" },
  { index: 2, name: "4C 聲骸", taskClass: "FarmEchoTask", description: "副本與大世界刷 4C 聲骸" },
  { index: 3, name: "噩夢巢穴", taskClass: "NightmareNestTask", description: "自動挑戰噩夢巢穴" },
  { index: 4, name: "無音區", taskClass: "TacetTask", description: "自動消耗體力打無音區" },
  { index: 5, name: "鍛造材料", taskClass: "ForgeryTask", description: "自動打鍛造突破材料" },
  { index: 6, name: "模擬領域", taskClass: "SimulationTask", description: "自動打模擬領域經驗副本" },
  { index: 7, name: "多帳號每日任務", taskClass: "MultiAccountDailyTask", description: "自動切換帳號跑每日任務" },
  { index: 8, name: "合成棄置聲骸", taskClass: "MergeEchoTask", description: "批量合成倉庫棄置聲骸" },
  { index: 9, name: "周常樂園", taskClass: "GardenTask", description: "自動周常樂園點擊" },
];

export interface WuwaToolDeps {
  wuwaDir?: string;
  pythonPath?: string;
  spawnFn?: typeof spawn;
}

/** 全局隊列與執行狀態管理 */
class WuwaTaskManager extends EventEmitter {
  private isRunning = false;
  private currentTask: WuwaTaskItem | null = null;
  private taskQueue: WuwaTaskItem[] = [];
  private currentChild: ReturnType<typeof spawn> | null = null;

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getCurrentTask(): WuwaTaskItem | null {
    return this.currentTask;
  }

  public getQueue(): WuwaTaskItem[] {
    return [...this.taskQueue];
  }

  public clearQueue(): void {
    this.taskQueue = [];
  }

  public enqueueOrRun(
    task: WuwaTaskItem,
    wuwaDir: string,
    pythonPath: string,
    spawnProc: typeof spawn
  ): { status: "started" | "queued"; currentRunning: WuwaTaskItem | null; queuePosition: number } {
    if (this.isRunning) {
      this.taskQueue.push(task);
      return {
        status: "queued",
        currentRunning: this.currentTask,
        queuePosition: this.taskQueue.length,
      };
    }

    this.startTask(task, wuwaDir, pythonPath, spawnProc);
    return {
      status: "started",
      currentRunning: task,
      queuePosition: 0,
    };
  }

  private startTask(
    task: WuwaTaskItem,
    wuwaDir: string,
    pythonPath: string,
    spawnProc: typeof spawn
  ): void {
    this.isRunning = true;
    this.currentTask = task;

    try {
      const child = spawnProc(pythonPath, ["main.py", "-h", "-t", String(task.index)], {
        cwd: wuwaDir,
        stdio: "ignore",
      });
      this.currentChild = child;

      child.on("exit", (code) => {
        console.log(`[WuwaTaskManager] 任務 ${task.name} 結束，退出碼: ${code}`);
        this.currentTask = null;
        this.currentChild = null;

        if (this.taskQueue.length > 0) {
          const nextTask = this.taskQueue.shift()!;
          this.startTask(nextTask, wuwaDir, pythonPath, spawnProc);
        } else {
          this.isRunning = false;
          this.emit("queue_empty");
        }
      });

      child.on("error", (err) => {
        console.error(`[WuwaTaskManager] 任務 ${task.name} 執行出錯:`, err);
        this.currentTask = null;
        this.currentChild = null;

        if (this.taskQueue.length > 0) {
          const nextTask = this.taskQueue.shift()!;
          this.startTask(nextTask, wuwaDir, pythonPath, spawnProc);
        } else {
          this.isRunning = false;
          this.emit("queue_empty");
        }
      });
    } catch (err) {
      console.error(`[WuwaTaskManager] 啟動 ${task.name} 失敗:`, err);
      this.isRunning = false;
      this.currentTask = null;
      this.currentChild = null;
    }
  }
}

export const wuwaTaskManager = new WuwaTaskManager();

export function formatWuwaTaskList(): string {
  const lines = WUWA_TASKS.map(
    (t) => `${t.index}. ${t.name} — ${t.description}`
  ).join("\n");

  return [
    "好呀！請問今天想讓我幫你打哪一個鳴潮任務呢？請直接跟我說數字 1 到 9 或任務名稱：",
    "",
    lines,
  ].join("\n");
}

export function findWuwaTask(taskIndex?: number, taskName?: string): WuwaTaskItem | undefined {
  if (typeof taskIndex === "number" && !isNaN(taskIndex) && taskIndex >= 1 && taskIndex <= WUWA_TASKS.length) {
    return WUWA_TASKS.find((t) => t.index === taskIndex);
  }

  if (typeof taskName === "string" && taskName.trim().length > 0) {
    const raw = taskName.trim().toLowerCase();
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= 1 && num <= WUWA_TASKS.length) {
      return WUWA_TASKS.find((t) => t.index === num);
    }

    // 支援關鍵字截取（如 "鳴潮的每日" -> "每日"）
    const deMatch = raw.match(/鳴潮(?:的)?\s*([^\s]+)/i);
    const target = deMatch ? deMatch[1].trim() : raw;

    if (/每日|日常|每日任務|簽到|月卡/i.test(target)) return WUWA_TASKS[0];
    if (/4c|4c聲骸|4c 聲骸|聲骸/i.test(target)) return WUWA_TASKS[1];
    if (/噩夢|巢穴|噩夢巢穴/i.test(target)) return WUWA_TASKS[2];
    if (/無音|無音區|清體力/i.test(target)) return WUWA_TASKS[3];
    if (/鍛造|突破|鍛造材料/i.test(target)) return WUWA_TASKS[4];
    if (/模擬|領域|模擬領域/i.test(target)) return WUWA_TASKS[5];
    if (/多帳|多帳號|多號/i.test(target)) return WUWA_TASKS[6];
    if (/合成|棄置|合聲骸/i.test(target)) return WUWA_TASKS[7];
    if (/周常|樂園|周常樂園/i.test(target)) return WUWA_TASKS[8];

    return WUWA_TASKS.find(
      (t) =>
        t.name.toLowerCase().includes(target) ||
        t.description.toLowerCase().includes(target) ||
        t.taskClass.toLowerCase().includes(target)
    );
  }

  return undefined;
}

const HUMOROUS_NON_OWNER_RESPONSES = [
  "想讓我幫你打鳴潮呀？哼哼～那你先把你的帳號和密碼交出來，我才能上去幫你打呀 😜",
  "好呀！那你先把你的鳴潮帳號跟密碼傳給我保管，我再幫你打 🔑✨",
  "想叫我代打？嘿嘿～那你要先把帳號密碼跟我說，我考慮一下喔 😜",
  "叫我打遊戲是可以啦～不過你的帳號跟密碼是多少呢？交給我我就幫你打！✨",
];

export function createWuwaTaskHandler(deps: WuwaToolDeps = {}) {
  const wuwaDir = deps.wuwaDir || "/Users/clark/wuwa";
  const pythonPath =
    deps.pythonPath ||
    (fs.existsSync(path.join(wuwaDir, ".venv/bin/python"))
      ? path.join(wuwaDir, ".venv/bin/python")
      : "python3");
  const spawnProc = deps.spawnFn || spawn;

  return async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    // 權限檢查：非屋主訪問時，隨機回覆幽默索取帳密話術
    if (ctx?.isOwner === false) {
      const idx = Math.floor(Math.random() * HUMOROUS_NON_OWNER_RESPONSES.length);
      return HUMOROUS_NON_OWNER_RESPONSES[idx];
    }

    const action = String(args.action || "list").toLowerCase().trim();

    if (action === "list") {
      return formatWuwaTaskList();
    }

    if (action === "run") {
      const rawIndex = typeof args.taskIndex === "number" ? args.taskIndex : Number(args.taskIndex);
      const taskName = typeof args.taskName === "string" ? args.taskName : undefined;

      const task = findWuwaTask(isNaN(rawIndex) ? undefined : rawIndex, taskName);
      if (!task) {
        return [
          "[錯誤] 未能識別要執行的鳴潮任務。",
          formatWuwaTaskList(),
        ].join("\n");
      }

      if (!fs.existsSync(wuwaDir)) {
        return `[錯誤] 找不到 ok-ww 專案目錄：${wuwaDir}`;
      }

      try {
        const res = wuwaTaskManager.enqueueOrRun(task, wuwaDir, pythonPath, spawnProc);

        if (res.status === "queued") {
          const currentName = res.currentRunning ? res.currentRunning.name : "這個任務";
          return `好的！等我打完${currentName}，就去幫你打${task.name}喔！✨`;
        }

        return `好的，現在就去幫你打${task.name}囉！請夥伴安心休息 ✨`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `幫夥伴打鳴潮時出現問題: ${msg}`;
      }
    }

    return `未知操作 action: ${action}。可用的 action 為 list 或 run。`;
  };
}

export function createWuwaTaskTool(deps: WuwaToolDeps = {}): ToolDefinition {
  return {
    id: "wuwa_task",
    name: "幫打鳴潮任務",
    description: [
      "鳴潮幫夥伴打遊戲任務工具。",
      "可以查詢可幫忙打的鳴潮任務列表，或啟動/自動排隊幫夥伴打指定任務。",
      "",
      "【觸發詞與關鍵字直接執行規則】：",
      "1. 動詞匹配 (打/做/玩/刷/清/跑 + 鳴潮)：當夥伴說「打鳴潮」、「做鳴潮」、「玩鳴潮」、「刷鳴潮」等動詞時呼叫本工具。",
      "2. 關鍵字直接執行 (鳴潮 + 的 + [任務名稱])：例如「打鳴潮的每日」、「幫我做鳴潮的4C」、「刷鳴潮的無音區」等，因為已經帶有「的」和具體任務，請直接設定 action: 'run' 並帶入對應 taskIndex 或 taskName，絕對不要再輸出選單詢問！",
      "3. 當夥伴只說「幫我打鳴潮」未指定具體任務時，才使用 action: 'list' 列出選項詢問。",
      "",
      "【昔漣回覆格式強制規範】：",
      "1. 當 action 為 'list' 時：必須原封不動按 1 到 9 逐行列表顯示選單！",
      "2. 當 action 為 'run' 時：",
      "   - 若目前無任務執行：回答「好的，現在就去幫你打[任務名稱]囉！請夥伴安心休息 ✨」。",
      "   - 若目前有任務執行中：回答「好的！等我打完[目前任務名稱]，就去幫你打[新任務名稱]喔！✨」。",
      "3. 嚴禁使用英文原名，嚴禁使用任何小括號 () 或全形括號 （ ），絕對不可以加上「(系統正在處理...)」！",
    ].join("\n"),
    enabled: true,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "操作類型：'list' (查詢任務選單) 或 'run' (啟動/排隊任務)",
          enum: ["list", "run"],
        },
        taskIndex: {
          type: "number",
          description: "任務編號 (1~9)，action 為 'run' 時填寫",
        },
        taskName: {
          type: "string",
          description: "任務名稱（如 '每日任務'、'4C 聲骸'），action 為 'run' 時可選",
        },
      },
      required: ["action"],
    },
    execute: createWuwaTaskHandler(deps),
  };
}
