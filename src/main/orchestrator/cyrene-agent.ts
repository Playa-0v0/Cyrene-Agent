// CyreneAgent —— 把 Function Calling 循環包進 AG-UI 的 AbstractAgent。
//
// AG-UI 是事件協議：AbstractAgent.run() 返回 Observable<BaseEvent>，
// 我們在 Observable 內部跑 FC 循環，每一步 observer.next() 一個標準事件：
//   RUN_STARTED → (每輪 STEP_STARTED → 可能 TOOL_CALL_* → STEP_FINISHED) →
//   TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT(逐字) → TEXT_MESSAGE_END → RUN_FINISHED
//
// 設計要點：
// - FC 循環仍是 stream:false 一次性拿全文（不碰 LLM 層），拿到全文後切成 delta 逐個發
//   TEXT_MESSAGE_CONTENT，這就是"流式感"的來源——標準 AG-UI 做法。
// - run() 不做副作用（不寫記憶、不推斷表情）。那些在橋層 runAgent 完成後做，
//   保持 agent 純粹只管"產出事件流"。
// - 錯誤用 observer.error() 拋，橋層捕獲。
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tool-registry";
import { type ToolCallResult } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { recordAgentActivity } from "../agent-activity-store";
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

const LOG_PREFIX = "[CyreneAgent]";
const MAX_TOOL_ROUNDS = 20; // 多步任務（寫 Excel 多 sheet、生成圖片等）可能耗多輪；到頂強制無工具總結兜底
const PER_ROUND_TIMEOUT_MS = 75000; // 推理模型帶 thinking，30s 偏緊，放寬到 75s
const FORCE_SUMMARY_TIMEOUT_MS = 90000; // 強制總結兜底：對話歷史此時已很長，30s 不夠，放寬到 90s
// 連續超時即退出：超時後重試只會讓上下文更長更慢，形成"超時→加消息→更慢→再超時"死循環。
// 連續 MAX_CONSECUTIVE_TIMEOUTS 次超時直接跳出走強制總結，不再空轉浪費時間。
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** 廠商配置（結構兼容 main/index.ts 的 ModelSettings，避免循環依賴）。 */
export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** CyreneAgent.run() 需要的輸入——橋層構造好後塞進 input.state 或 forwardedProps。 */
export interface CyreneRunOptions {
  settings: AgentLoopSettings;
  /** 已經拼好 system prompt 的完整消息（含 system + user/assistant）。 */
  messages: ChatMessage[];
  timeoutMs: number;
  /** 可選：本次 run 的工具集合。未傳時使用當前所有已啟用工具。 */
  tools?: ToolDefinition[];
}

/** FC 循環最終結果（供橋層做副作用用）。 */
export interface CyreneRunResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
}

/** 把 ToolRegistry 裡的工具轉成統一 ToolSpec（與 wire 格式解耦）。 */
function buildToolSpecs(tools: ToolDefinition[] = toolRegistry.getEnabledTools()): ToolSpec[] {
  return tools.filter(t => t.enabled).map(t => ({
    name: t.id,
    description: t.description,
    parameters: {
      type: "object",
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
}

/** 逐字切片：按字符（emoji 安全）切，每片 1 字（渲染端 CSS 漸顯用）。 */
function sliceToDeltas(text: string, chunkSize = 1): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    out.push(chars.slice(i, i + chunkSize).join(""));
  }
  return out.length > 0 ? out : [text];
}

/**
 * 把一份完整文本以 TEXT_MESSAGE 流發出。
 * 返回該文本（供調用方記到 toolResults 等用）。
 */
function emitTextMessage(
  observer: { next: (e: BaseEvent) => void },
  messageId: string,
  text: string,
): void {
  observer.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
  // 逐字切片發 delta（每片 4 字，emoji 安全），渲染端逐字累積實現流式感。
  // FC 仍是 stream:false 一次性拿全文，這裡切片只是把"整段一次"變成"多段快速"。
  for (const delta of sliceToDeltas(text)) {
    observer.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
  }
  observer.next({ type: EventType.TEXT_MESSAGE_END, messageId });
}

/**
 * 強制總結也失敗時的降級文案。用已收集的工具結果拼一個"任務中斷"回覆，
 * 避免整個 run 拋 subscriber.error 讓用戶徹底看不到任何回覆。
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
      // 截斷過長的工具輸出，只給模型/用戶一個概覽
      const preview = r.output.length > 200 ? r.output.slice(0, 200) + "…" : r.output;
      lines.push("- 「" + r.toolId + "」：" + preview);
    }
  } else {
    lines.push("", "（暫無已完成的步驟信息）");
  }
  return lines.join("\n");
}

/**
 * 執行一輪 Function Calling 循環（廠商無關），每步發 AG-UI 事件。
 * 內聯自 function-calling.ts，保持邏輯一致，只加事件發射。
 */
async function runFcLoopWithEvents(
  options: CyreneRunOptions,
  observer: { next: (e: BaseEvent) => void; error: (e: unknown) => void; complete: () => void },
): Promise<CyreneRunResult> {
  const { settings, messages, timeoutMs } = options;
  const adapter = getAdapter(settings.provider);
  const runTools = options.tools ?? toolRegistry.getEnabledTools();
  const tools = buildToolSpecs(runTools);
  const runnableToolIds = new Set(runTools.filter(t => t.enabled).map(t => t.id));
  const allToolResults: ToolCallResult[] = [];
  const startTime = Date.now();
  let accInput = 0;
  let accOutput = 0;
  let consecutiveTimeouts = 0; // 連續超時計數：達到上限直接跳出走強制總結

  console.log(LOG_PREFIX, `provider=${settings.provider} transport=${adapter.transport} model=${settings.model}`);
  console.log(LOG_PREFIX, "可用工具:", tools.map(t => t.name).join(", ") || "(無)");
  console.log(LOG_PREFIX, "消息數:", messages.length, "最後一角色:", messages[messages.length - 1]?.role);

  let conversation: ChatMessage[] = messages.map(m => ({ ...m }));
  console.log(LOG_PREFIX, "CONVERSATION DETAILED SIZES:", conversation.map(m => ({ role: m.role, length: m.content?.length })));

  // 清空本輪 skill reference 已讀記錄，防止跨對話汙染
  resetReadRefs();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundStart = Date.now();

    if (Date.now() - startTime > timeoutMs) {
      console.warn(LOG_PREFIX, "Function Calling 超時，在第 " + (round + 1) + " 輪退出");
      break;
    }

    observer.next({ type: EventType.STEP_STARTED, stepName: `round-${round + 1}` });
    console.log(LOG_PREFIX, "第 " + (round + 1) + " 輪 LLM 調用...");

    let req: ChatRequest = {
      model: settings.model,
      messages: conversation,
      ...(tools.length > 0 ? { tools } : {}),
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
          observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
          break;
        }
        observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
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

    // 情況1：模型要調工具
    if (chat.toolCalls.length > 0) {
      console.log(
        LOG_PREFIX,
        "模型請求調用 " + chat.toolCalls.length + " 個工具:",
        chat.toolCalls.map(tc => tc.name).join(", "),
      );

      const execResults: ToolExecutionResult[] = [];
      for (const tc of chat.toolCalls) {
        const toolStartedAt = Date.now();
        const toolCallId = tc.id || `${tc.name}-${Date.now()}`;
        const displayTool = toolRegistry.getById(tc.name);
        // 工具調用開始事件（toolCallName 用顯示名，找不到工具則用 id 兜底）
        observer.next({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: displayTool?.name ?? tc.name,
        });

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.warn(LOG_PREFIX, "工具參數 JSON 解析失敗:", tc.arguments?.slice(0, 100));
        }

        console.log(LOG_PREFIX, "執行工具:", tc.name, JSON.stringify(args).slice(0, 200));

        let output: string;
        const tool = runnableToolIds.has(tc.name) ? toolRegistry.getById(tc.name) : undefined;
        if (!tool || !tool.enabled) {
          output = "[錯誤] 工具不可用: " + tc.name;
          console.warn(LOG_PREFIX, output);
        } else {
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
            const isOwner = (options as { isOwner?: boolean })?.isOwner ?? true;
            const ctx: ToolContext | undefined = tool.needsContext
              ? { userQuery: extractLastUserQuery(conversation), isOwner }
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

        // 工具調用結果事件 + 結束事件
        observer.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: `${toolCallId}-result`,
          content: output,
        });
        observer.next({ type: EventType.TOOL_CALL_END, toolCallId });
      }

      conversation = adapter.appendToolResults(conversation, execResults);

      // 防線②：窗口級壓縮——conversation 累積超閾值時摘要化舊輪次
      conversation = compressConversation(conversation);

      observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
      continue;
    }

    // 情況2：模型正常返回文本 → 發 TEXT_MESSAGE 流
    const content = chat.text || "";
    console.log(LOG_PREFIX, "Function Calling 完成，最終回覆長度=" + content.length);
    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(observer, textMessageId, content);

    observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: content, toolResults: allToolResults, totalUsage };
  }

  // 超過最大輪數，強制要求模型總結（不帶 tools）
  console.warn(LOG_PREFIX, "達到最大輪數 " + MAX_TOOL_ROUNDS + "，強制要求模型回覆");
  conversation.push({
    role: "user",
    content: "請基於以上所有工具返回的信息，給出最終回覆。不要繼續調用工具。",
  });

  observer.next({ type: EventType.STEP_STARTED, stepName: "force-summary" });

  let finalReq: ChatRequest = {
    model: settings.model,
    messages: conversation,
    stream: false,
  };
  if (adapter.applyCacheHints) finalReq = adapter.applyCacheHints(finalReq, settings);
  const http = adapter.buildRequest(finalReq, settings);
  console.log(LOG_PREFIX, "請求:", http.url);

  const controller = new AbortController();
  // 強制總結是最後兜底：對話歷史此時往往已很長，30s 不夠模型生成完會被 abort，
  // 導致整個 run 拋錯用戶徹底沒回復。放寬到 90s。
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
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1, settings.model);
    }

    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(observer, textMessageId, chat.text);

    observer.next({ type: EventType.STEP_FINISHED, stepName: "force-summary" });
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: chat.text, toolResults: allToolResults, totalUsage };
  } catch (err) {
    // 兜底再失敗也別讓整個 run 崩掉（subscriber.error 會讓用戶徹底沒回復）。
    // 用已收集的工具結果拼一個"任務中斷"文案降級返回。
    const reason = err instanceof Error && err.name === "AbortError"
      ? "總結請求超時"
      : (err instanceof Error ? err.message : String(err));
    console.error(LOG_PREFIX, "強制總結也失敗，降級返回已有結果:", reason);
    const fallback = buildFallbackReply(allToolResults, reason);
    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(observer, textMessageId, fallback);
    observer.next({ type: EventType.STEP_FINISHED, stepName: "force-summary" });
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: fallback, toolResults: allToolResults, totalUsage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CyreneAgent —— 單次對話一個實例。
 *
 * 用法：
 *   const agent = new CyreneAgent({ threadId });
 *   const result = await agent.runAgentWith(options);  // 跑循環 + 事件流
 *
 * 注意：不直接用 runAgent(parameters)，因為我們的輸入（settings/messages）是自定義的，
 * 通過 runOptions 傳入更直接。runAgent 的 Observable 橋接在橋層做。
 */
export class CyreneAgent extends AbstractAgent {
  /** 跑循環結果，run() 完成後可取（供橋層做副作用）。 */
  lastResult?: CyreneRunResult;

  /**
   * 跑 FC 循環並返回事件流。橋層訂閱這個流轉發給渲染進程。
   * 傳入的 options 會原樣跑——settings/messages/timeout 都在這裡。
   */
  runWithEvents(options: CyreneRunOptions): Observable<BaseEvent> {
    const threadId = this.threadId;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      (async () => {
        try {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
          const result = await runFcLoopWithEvents(options, subscriber);
          this.lastResult = result;
          if (cancelled) return;
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          });
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          console.error(LOG_PREFIX, "run 失敗:", err);
          subscriber.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return () => { cancelled = true; };
    });
  }

  // AbstractAgent 要求實現 run(input)，但我們用 runWithEvents 更直接。
  // 保留 run 作為一個薄封裝，供標準 AG-UI 調用路徑（暫不用）。
  protected _runOptions?: CyreneRunOptions;
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this._runOptions) {
      return new Observable<BaseEvent>((s) => {
        s.error(new Error("CyreneAgent.run 被直接調用，但未設置 _runOptions。請用 runWithEvents。"));
      });
    }
    void input;
    return this.runWithEvents(this._runOptions);
  }
}
