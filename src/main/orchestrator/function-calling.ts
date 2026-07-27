// Function Calling —— 廠商無關的 function calling 循環
// 調度層只依賴 vendors adapter 的統一返回結構（buildRequest / parseResponse / appendToolResults），
// 絕不出現 if (provider === "xxx")。新廠商擴展只需在 capabilities.ts + 對應 transport adapter 里加一條。
import { toolRegistry, ToolDefinition } from "./tool-registry";
import { ToolCallResult } from "./types";
import { checkPermission, ToolRiskLevel } from "../permission";
import {
  getAdapter,
  type ChatMessage,
  type ChatRequest,
  type ToolExecutionResult,
  type ToolSpec,
} from "./vendors";
import { extractLastUserQuery, type ToolContext } from "./tool-context";
import { recordUsage } from "../token-usage-store";
import { resetReadRefs } from "../skills/skill-tools";
import { truncateToolResult, compressConversation } from "./context-manager";
import { recordAgentActivity } from "../agent-activity-store";

const LOG_PREFIX = "[FunctionCalling]";
const MAX_TOOL_ROUNDS = 20; // 多步任務（寫 Excel 多 sheet、生成圖片等）可能耗多輪；到頂強制無工具總結兜底
const PER_ROUND_TIMEOUT_MS = 75000; // 推理模型帶 thinking，30s 偏緊，放寬到 75s
const FORCE_SUMMARY_TIMEOUT_MS = 90000; // 強制總結兜底：對話歷史此時已很長，30s 不夠，放寬到 90s
// 連續超時即退出：超時後重試只會讓上下文更長更慢，形成"超時→加消息→更慢→再超時"死循環。
// 連續 MAX_CONSECUTIVE_TIMEOUTS 次超時直接跳出走強制總結，不再空轉浪費時間。
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** 調度層傳入的廠商配置（結構兼容 main/index.ts 的 ModelSettings，避免循環依賴）。 */
interface LoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 把 ToolRegistry 裡的工具轉成統一 ToolSpec（與 wire 格式解耦）。 */
function buildToolSpecs(): ToolSpec[] {
  return toolRegistry.getEnabledTools().map(t => ({
    name: t.id,
    description: t.description,
    parameters: {
      type: "object",
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
}

/**
 * 強制總結也失敗時的降級文案。用已收集的工具結果拼一個"任務中斷"回覆，
 * 避免整個 run 拋錯讓用戶徹底看不到任何回覆。
 * （與 cyrene-agent.ts 中的版本保持一致，但不引入其 AG-UI 依賴）
 */
function buildFallbackReply(toolResults: ToolCallResult[], reason: string): string {
  const lines: string[] = [
    "抱歉，任務執行到一半被中斷了。",
    "",
    "中斷原因：" + reason,
  ];
  if (toolResults.length > 0) {
    lines.push("", "以下是中斷前已經完成的步驟：");
    for (const r of toolResults) {
      const preview = r.output.length > 200 ? r.output.slice(0, 200) + "…" : r.output;
      lines.push("- 「" + r.toolId + "」：" + preview);
    }
  } else {
    lines.push("", "（暫無已完成的步驟信息）");
  }
  return lines.join("\n");
}

/**
 * 執行一輪 function calling 循環（廠商無關）。
 *
 * 流程：
 * 1. adapter.buildRequest(messages + tools) → 發到 LLM
 * 2. adapter.parseResponse → 若有 toolCalls → 執行工具 → adapter.appendToolResults → 回到 1
 * 3. 若無 toolCalls → 返回最終文本 + 所有工具執行結果
 *
 * @returns { reply, toolResults }
 */
export async function runFunctionCallingLoop(
  settings: LoopSettings,
  messages: ChatMessage[],
  timeoutMs: number = 60000,
): Promise<{
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
}> {
  const adapter = getAdapter(settings.provider);
  const tools = buildToolSpecs();
  const allToolResults: ToolCallResult[] = [];
  const startTime = Date.now();
  // 累加所有輪次的 token 用量（工具循環可能多輪，每輪都有 usage）
  let accInput = 0;
  let accOutput = 0;
  let consecutiveTimeouts = 0; // 連續超時計數：達到上限直接跳出走強制總結

  console.log(LOG_PREFIX, `provider=${settings.provider} transport=${adapter.transport} model=${settings.model}`);
  console.log(LOG_PREFIX, "可用工具:", tools.map(t => t.name).join(", ") || "(無)");
  console.log(LOG_PREFIX, "消息數:", messages.length, "最後一角色:", messages[messages.length - 1]?.role);

  let conversation: ChatMessage[] = messages.map(m => ({ ...m }));

  // 清空本輪 skill reference 已讀記錄，防止跨對話汙染
  resetReadRefs();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundStart = Date.now();

    if (Date.now() - startTime > timeoutMs) {
      console.warn(LOG_PREFIX, "Function Calling 超時，在第 " + (round + 1) + " 輪退出");
      break;
    }

    console.log(LOG_PREFIX, "第 " + (round + 1) + " 輪 LLM 調用...");

    let req: ChatRequest = {
      model: settings.model,
      messages: conversation,
      ...(tools.length > 0 ? { tools } : {}),
      // 不傳 temperature：不同型號約束不同（如 Kimi k2.6 只允許 1），讓廠商用默認值
      stream: false,
    };
    if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, settings);

    const http = adapter.buildRequest(req, settings);
    console.log(LOG_PREFIX, "請求:", http.url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ROUND_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(http.url, {
        method: "POST",
        signal: controller.signal,
        headers: http.headers,
        body: http.body,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        consecutiveTimeouts++;
        console.warn(LOG_PREFIX, "第 " + (round + 1) + " 輪 LLM 請求超時（" + PER_ROUND_TIMEOUT_MS + "ms），連續第 " + consecutiveTimeouts + " 次");
        clearTimeout(timer);
        // 連續超時即退出：再重試只會讓上下文更長更慢，註定超時。
        // 不再往 conversation 塞"超時提示"消息（雪上加霜），直接跳出走強制總結。
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          console.warn(LOG_PREFIX, "連續 " + MAX_CONSECUTIVE_TIMEOUTS + " 次超時，跳出 FC 循環走強制總結");
          break;
        }
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(LOG_PREFIX, "LLM 請求失敗 HTTP " + response.status + ":", errorText.slice(0, 300));
      throw new Error("模型請求失敗：HTTP " + response.status + (errorText ? " — " + errorText.slice(0, 200) : ""));
    }

    const data = await response.json();
    const chat = adapter.parseResponse(data);

    // 累加 token 用量（每輪都記）
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1, settings.model);
    }

    console.log(
      LOG_PREFIX,
      "第 " + (round + 1) + " 輪完成 finish=" + chat.finishReason +
      " toolCalls=" + chat.toolCalls.length + " thinking=" + (chat.thinking ? "有" : "無") +
      " 耗時=" + (Date.now() - roundStart) + "ms",
    );

    // 請求成功，重置連續超時計數
    consecutiveTimeouts = 0;

    // 把 assistant 消息加入對話（adapter 已保留 thinking / rawAssistant 供下輪迴傳）
    conversation.push(chat.assistantMessage);

    // 情況1：模型要調工具（按 toolCalls 數量判斷，與 transport 無關）
    if (chat.toolCalls.length > 0) {
      console.log(
        LOG_PREFIX,
        "模型請求調用 " + chat.toolCalls.length + " 個工具:",
        chat.toolCalls.map(tc => tc.name).join(", "),
      );

      const execResults: ToolExecutionResult[] = [];
      for (const tc of chat.toolCalls) {
        const toolStartedAt = Date.now();
        const tool = toolRegistry.getById(tc.name);

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.warn(LOG_PREFIX, "工具參數 JSON 解析失敗:", tc.arguments?.slice(0, 100));
        }

        console.log(LOG_PREFIX, "執行工具:", tc.name, JSON.stringify(args).slice(0, 200));

        let output: string;
        if (!tool || !tool.enabled) {
          output = "[錯誤] 工具不可用: " + tc.name;
          console.warn(LOG_PREFIX, output);
        } else {
          // 權限網關：內置工具默認 safe，MCP 工具按其 risk 字段判定
          const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
          const perm = await checkPermission({
            toolId: tc.name,
            toolName: tool.name,
            toolDescription: tool.description,
            args,
            risk,
          });
          if (!perm.allowed) {
            output = "[已拒絕] " + (perm.reason || "權限不足");
            console.warn(LOG_PREFIX, "權限拒絕 [" + tc.name + "]:", perm.reason);
          } else {
            // ToolContext 注入：聲明 needsContext 的工具拿到用戶當前問題。
            // 能力判斷交給工具內部（read_image 自己查視覺配置），調度層不再提前門控。
            const ctx: ToolContext | undefined = tool.needsContext
              ? { userQuery: extractLastUserQuery(conversation) }
              : undefined;
            try {
              output = await tool.execute(args, ctx);
              console.log(LOG_PREFIX, "工具返回 [" + tc.name + "]:", output.slice(0, 200));
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              output = "[工具執行失敗] " + errMsg;
              console.error(LOG_PREFIX, "工具執行失敗 [" + tc.name + "]:", errMsg);
            }
          }
        }

        recordAgentActivity({
          kind: output.startsWith("[已拒絕]") ? "permission" : "tool",
          name: tc.name,
          status: output.startsWith("[已拒絕]") ? "denied" : output.startsWith("[錯誤]") || output.startsWith("[工具執行失敗]") ? "failed" : "success",
          durationMs: Date.now() - toolStartedAt,
          args,
          result: output,
          ...(output.startsWith("[錯誤]") || output.startsWith("[工具執行失敗]") ? { error: output } : {}),
        });

        allToolResults.push({ toolId: tc.name, args, output });
        // execResults 進 conversation，截斷防單條大結果爆窗
        execResults.push({ toolCall: tc, output: truncateToolResult(output) });
      }

      // adapter 負責把 tool result 按各自協議回灌
      // （OpenAI: 多條 role:tool；Anthropic: 合併進 user 的 tool_result block）
      conversation = adapter.appendToolResults(conversation, execResults);

      // 防線②：窗口級壓縮——conversation 累積超閾值時摘要化舊輪次
      conversation = compressConversation(conversation);

      continue;
    }

    // 情況2：模型正常返回文本
    const content = chat.text || "";
    console.log(LOG_PREFIX, "Function Calling 完成，最終回覆長度=" + content.length);
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: content, toolResults: allToolResults, totalUsage };
  }

  // 超過最大輪數，強制要求模型總結（不帶 tools）
  console.warn(LOG_PREFIX, "達到最大輪數 " + MAX_TOOL_ROUNDS + "，強制要求模型回覆");
  conversation.push({
    role: "user",
    content: "請基於以上所有工具返回的信息，給出最終回覆。不要繼續調用工具。",
  });

  let finalReq: ChatRequest = {
    model: settings.model,
    messages: conversation,
    // 不傳 temperature：不同型號約束不同，讓廠商用默認值
    stream: false,
  };
  if (adapter.applyCacheHints) finalReq = adapter.applyCacheHints(finalReq, settings);
  const http = adapter.buildRequest(finalReq, settings);
  console.log(LOG_PREFIX, "請求:", http.url);

  const controller = new AbortController();
  // 強制總結是最後兜底：對話歷史此時往往已很長，30s 不夠模型生成完會被 abort，
  // 導致整個 run 拋錯用戶徹底沒回復。放寬到 90s，且失敗時降級返回已有工具結果。
  const timer = setTimeout(() => controller.abort(), FORCE_SUMMARY_TIMEOUT_MS);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      throw new Error("最終回覆請求失敗：HTTP " + response.status);
    }

    const data = await response.json();
    const chat = adapter.parseResponse(data);
    console.log(LOG_PREFIX, "強制回覆完成，長度=" + chat.text.length);
    // 最終回覆也記 usage
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1, settings.model);
    }
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: chat.text, toolResults: allToolResults, totalUsage };
  } catch (err) {
    // 兜底再失敗也別讓整個 run 崩掉（拋錯會讓用戶徹底沒回復）。
    // 用已收集的工具結果拼一個"任務中斷"文案降級返回。
    const reason = err instanceof Error && err.name === "AbortError"
      ? "總結請求超時"
      : (err instanceof Error ? err.message : String(err));
    console.error(LOG_PREFIX, "強制總結也失敗，降級返回已有結果:", reason);
    const fallback = buildFallbackReply(allToolResults, reason);
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: fallback, toolResults: allToolResults, totalUsage };
  } finally {
    clearTimeout(timer);
  }
}
