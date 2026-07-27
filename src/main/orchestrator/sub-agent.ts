// 子代理（Sub-agent）—— 把重任務委託給獨立 FC 循環執行，隔離上下文。
//
// 核心思路：
//   主 agent 調 delegate_task 工具 → execute 內部跑一個受限的 runFunctionCallingLoop
//   → 子代理有自己的 conversation（用完即棄）
//   → 執行完只返回結構化摘要給主 agent
//   → 主 agent 的 conversation 只多一條摘要，不被重工具的過程數據汙染
//
// 觸發條件（調用鏈深度判斷）：
//   單次工具調用能完成 → 不需要子代理
//   需要 ≥2 步工具調用且中間結果不需要用戶確認 → 子代理化
//
// 子代理限制：
//   - 最多 8 輪（主 agent 是 20 輪）
//   - 每輪超時 60s（主 agent 是 75s）
//   - 只暴露輕量工具（不暴露 delegate_task 自身，防遞歸）

import { runFunctionCallingLoop } from "./function-calling";
import { toolRegistry } from "./tool-registry";
import { truncateToolResult } from "./context-manager";

const LOG_PREFIX = "[SubAgent]";

/** 子代理限制。比主 agent 更緊——子代理是執行層，不該跑太久。 */
const SUB_AGENT_MAX_ROUNDS = 8;
const SUB_AGENT_TIMEOUT_MS = 60_000;

/** 子代理不能調用的工具（防遞歸 + 防重複權限審批）。 */
const BLOCKED_TOOLS = new Set([
  "delegate_task",     // 防遞歸
  "ask_user_choice",   // 子代理不該跟用戶交互（只有主 agent 能彈卡片）
]);

/** 子代理返回的結構化結果。 */
export interface SubAgentResult {
  status: "success" | "error";
  summary: string;
  artifacts?: string[];
  key_facts?: Record<string, unknown>;
  error_type?: "timeout" | "tool_error" | "parsing_error" | "max_rounds";
  recoverable?: boolean;
}

/** LLM 配置注入器（由 index.ts 啟動時調 setDelegateSettings 設置）。 */
let delegateSettingsGetter: (() => { provider: string; baseUrl: string; model: string; apiKey: string }) | null = null;

/** index.ts 啟動時調用，注入 LLM 配置獲取器給子代理。 */
export function setDelegateSettings(getter: () => { provider: string; baseUrl: string; model: string; apiKey: string }): void {
  delegateSettingsGetter = getter;
}

/**
 * 啟動子代理執行一個子任務。
 * 子代理有自己獨立的 conversation，執行完返回結構化摘要。
 */
export async function runSubAgent(task: string): Promise<SubAgentResult> {
  if (!delegateSettingsGetter) {
    return {
      status: "error",
      error_type: "tool_error",
      recoverable: false,
      summary: "子代理未配置 LLM 設置",
    };
  }

  const settings = delegateSettingsGetter();

  // 臨時屏蔽子代理不該用的工具
  const hiddenTools: string[] = [];
  for (const toolId of BLOCKED_TOOLS) {
    const tool = toolRegistry.getById(toolId);
    if (tool && tool.enabled) {
      tool.enabled = false;
      hiddenTools.push(toolId);
    }
  }

  try {
    console.log(LOG_PREFIX, "啟動子代理任務:", task.slice(0, 100));

    const subMessages = [
      {
        role: "system" as const,
        content:
          "你是一個子代理，負責執行主代理分配的具體任務。\n" +
          "高效執行，不要列任務清單，不要詢問用戶。\n" +
          "完成後用一句話總結結果。如果失敗，說明原因。",
      },
      { role: "user" as const, content: task },
    ];

    const result = await runFunctionCallingLoop(
      settings,
      subMessages,
      SUB_AGENT_TIMEOUT_MS,
    );

    const reply = result.reply || "(無回覆)";
    const toolCount = result.toolResults.length;

    // 收集產出文件（從工具結果裡提取路徑）
    const artifacts: string[] = [];
    const keyFacts: Record<string, unknown> = {};
    for (const tr of result.toolResults) {
      // 提取 write_* 工具的輸出路徑
      const pathMatch = tr.output.match(/已生成[：:]\s*(.+)/);
      if (pathMatch) artifacts.push(pathMatch[1].trim());
      // 提取匯率數據
      const rateMatch = tr.output.match(/(\d+(?:\.\d+)?)\s*(USD|EUR|CNY)\s*=\s*(\d+(?:\.\d+)?)\s*(USD|EUR|CNY)/);
      if (rateMatch) {
        keyFacts[rateMatch[2] + "_to_" + rateMatch[4]] = Number(rateMatch[3]);
      }
    }

    // 判斷是否達到最大輪數（可能沒完成）
    const hitMaxRounds = toolCount > 0 && reply.length < 50;

    console.log(LOG_PREFIX, "子代理完成:", reply.slice(0, 100), "工具調用:", toolCount);

    return {
      status: hitMaxRounds ? "error" : "success",
      summary: truncateToolResult(reply, 500),
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      key_facts: Object.keys(keyFacts).length > 0 ? keyFacts : undefined,
      error_type: hitMaxRounds ? "max_rounds" : undefined,
      recoverable: hitMaxRounds ? true : undefined,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes("AbortError") || errMsg.includes("超時");
    console.error(LOG_PREFIX, "子代理失敗:", errMsg);

    return {
      status: "error",
      error_type: isTimeout ? "timeout" : "tool_error",
      recoverable: isTimeout,
      summary: "子代理執行失敗：" + errMsg.slice(0, 200),
    };
  } finally {
    // 恢復被隱藏的工具
    for (const toolId of hiddenTools) {
      const tool = toolRegistry.getById(toolId);
      if (tool) tool.enabled = true;
    }
  }
}
