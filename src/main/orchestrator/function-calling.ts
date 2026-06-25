// Function Calling —— 厂商无关的 function calling 循环
// 调度层只依赖 vendors adapter 的统一返回结构（buildRequest / parseResponse / appendToolResults），
// 绝不出现 if (provider === "xxx")。新厂商扩展只需在 capabilities.ts + 对应 transport adapter 里加一条。
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

const LOG_PREFIX = "[FunctionCalling]";
const MAX_TOOL_ROUNDS = 20; // 多步任务（写 Excel 多 sheet、生成图片等）可能耗多轮；到顶强制无工具总结兜底
const PER_ROUND_TIMEOUT_MS = 75000; // 推理模型带 thinking，30s 偏紧，放宽到 75s
const FORCE_SUMMARY_TIMEOUT_MS = 90000; // 强制总结兜底：对话历史此时已很长，30s 不够，放宽到 90s
// 连续超时即退出：超时后重试只会让上下文更长更慢，形成"超时→加消息→更慢→再超时"死循环。
// 连续 MAX_CONSECUTIVE_TIMEOUTS 次超时直接跳出走强制总结，不再空转浪费时间。
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** 调度层传入的厂商配置（结构兼容 main/index.ts 的 ModelSettings，避免循环依赖）。 */
interface LoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 把 ToolRegistry 里的工具转成统一 ToolSpec（与 wire 格式解耦）。 */
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
 * 强制总结也失败时的降级文案。用已收集的工具结果拼一个"任务中断"回复，
 * 避免整个 run 抛错让用户彻底看不到任何回复。
 * （与 cyrene-agent.ts 中的版本保持一致，但不引入其 AG-UI 依赖）
 */
function buildFallbackReply(toolResults: ToolCallResult[], reason: string): string {
  const lines: string[] = [
    "抱歉，任务执行到一半被中断了。",
    "",
    "中断原因：" + reason,
  ];
  if (toolResults.length > 0) {
    lines.push("", "以下是中断前已经完成的步骤：");
    for (const r of toolResults) {
      const preview = r.output.length > 200 ? r.output.slice(0, 200) + "…" : r.output;
      lines.push("- 「" + r.toolId + "」：" + preview);
    }
  } else {
    lines.push("", "（暂无已完成的步骤信息）");
  }
  return lines.join("\n");
}

/**
 * 执行一轮 function calling 循环（厂商无关）。
 *
 * 流程：
 * 1. adapter.buildRequest(messages + tools) → 发到 LLM
 * 2. adapter.parseResponse → 若有 toolCalls → 执行工具 → adapter.appendToolResults → 回到 1
 * 3. 若无 toolCalls → 返回最终文本 + 所有工具执行结果
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
  // 累加所有轮次的 token 用量（工具循环可能多轮，每轮都有 usage）
  let accInput = 0;
  let accOutput = 0;
  let consecutiveTimeouts = 0; // 连续超时计数：达到上限直接跳出走强制总结

  console.log(LOG_PREFIX, `provider=${settings.provider} transport=${adapter.transport} model=${settings.model}`);
  console.log(LOG_PREFIX, "可用工具:", tools.map(t => t.name).join(", ") || "(无)");
  console.log(LOG_PREFIX, "消息数:", messages.length, "最后一角色:", messages[messages.length - 1]?.role);

  let conversation: ChatMessage[] = messages.map(m => ({ ...m }));

  // 清空本轮 skill reference 已读记录，防止跨对话污染
  resetReadRefs();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundStart = Date.now();

    if (Date.now() - startTime > timeoutMs) {
      console.warn(LOG_PREFIX, "Function Calling 超时，在第 " + (round + 1) + " 轮退出");
      break;
    }

    console.log(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 调用...");

    let req: ChatRequest = {
      model: settings.model,
      messages: conversation,
      ...(tools.length > 0 ? { tools } : {}),
      // 不传 temperature：不同型号约束不同（如 Kimi k2.6 只允许 1），让厂商用默认值
      stream: false,
    };
    if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, settings);

    const http = adapter.buildRequest(req, settings);
    console.log(LOG_PREFIX, "请求:", http.url);

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
        console.warn(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 请求超时（" + PER_ROUND_TIMEOUT_MS + "ms），连续第 " + consecutiveTimeouts + " 次");
        clearTimeout(timer);
        // 连续超时即退出：再重试只会让上下文更长更慢，注定超时。
        // 不再往 conversation 塞"超时提示"消息（雪上加霜），直接跳出走强制总结。
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          console.warn(LOG_PREFIX, "连续 " + MAX_CONSECUTIVE_TIMEOUTS + " 次超时，跳出 FC 循环走强制总结");
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
      console.error(LOG_PREFIX, "LLM 请求失败 HTTP " + response.status + ":", errorText.slice(0, 300));
      throw new Error("模型请求失败：HTTP " + response.status + (errorText ? " — " + errorText.slice(0, 200) : ""));
    }

    const data = await response.json();
    const chat = adapter.parseResponse(data);

    // 累加 token 用量（每轮都记）
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1);
    }

    console.log(
      LOG_PREFIX,
      "第 " + (round + 1) + " 轮完成 finish=" + chat.finishReason +
      " toolCalls=" + chat.toolCalls.length + " thinking=" + (chat.thinking ? "有" : "无") +
      " 耗时=" + (Date.now() - roundStart) + "ms",
    );

    // 请求成功，重置连续超时计数
    consecutiveTimeouts = 0;

    // 把 assistant 消息加入对话（adapter 已保留 thinking / rawAssistant 供下轮回传）
    conversation.push(chat.assistantMessage);

    // 情况1：模型要调工具（按 toolCalls 数量判断，与 transport 无关）
    if (chat.toolCalls.length > 0) {
      console.log(
        LOG_PREFIX,
        "模型请求调用 " + chat.toolCalls.length + " 个工具:",
        chat.toolCalls.map(tc => tc.name).join(", "),
      );

      const execResults: ToolExecutionResult[] = [];
      for (const tc of chat.toolCalls) {
        const tool = toolRegistry.getById(tc.name);

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.warn(LOG_PREFIX, "工具参数 JSON 解析失败:", tc.arguments?.slice(0, 100));
        }

        console.log(LOG_PREFIX, "执行工具:", tc.name, JSON.stringify(args).slice(0, 200));

        let output: string;
        if (!tool || !tool.enabled) {
          output = "[错误] 工具不可用: " + tc.name;
          console.warn(LOG_PREFIX, output);
        } else {
          // 权限网关：内置工具默认 safe，MCP 工具按其 risk 字段判定
          const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
          const perm = await checkPermission({
            toolId: tc.name,
            toolName: tool.name,
            toolDescription: tool.description,
            args,
            risk,
          });
          if (!perm.allowed) {
            output = "[已拒绝] " + (perm.reason || "权限不足");
            console.warn(LOG_PREFIX, "权限拒绝 [" + tc.name + "]:", perm.reason);
          } else {
            // ToolContext 注入：声明 needsContext 的工具拿到用户当前问题。
            // 能力判断交给工具内部（read_image 自己查视觉配置），调度层不再提前门控。
            const ctx: ToolContext | undefined = tool.needsContext
              ? { userQuery: extractLastUserQuery(conversation) }
              : undefined;
            try {
              output = await tool.execute(args, ctx);
              console.log(LOG_PREFIX, "工具返回 [" + tc.name + "]:", output.slice(0, 200));
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              output = "[工具执行失败] " + errMsg;
              console.error(LOG_PREFIX, "工具执行失败 [" + tc.name + "]:", errMsg);
            }
          }
        }

        allToolResults.push({ toolId: tc.name, args, output });
        // execResults 进 conversation，截断防单条大结果爆窗
        execResults.push({ toolCall: tc, output: truncateToolResult(output) });
      }

      // adapter 负责把 tool result 按各自协议回灌
      // （OpenAI: 多条 role:tool；Anthropic: 合并进 user 的 tool_result block）
      conversation = adapter.appendToolResults(conversation, execResults);

      // 防线②：窗口级压缩——conversation 累积超阈值时摘要化旧轮次
      conversation = compressConversation(conversation);

      continue;
    }

    // 情况2：模型正常返回文本
    const content = chat.text || "";
    console.log(LOG_PREFIX, "Function Calling 完成，最终回复长度=" + content.length);
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: content, toolResults: allToolResults, totalUsage };
  }

  // 超过最大轮数，强制要求模型总结（不带 tools）
  console.warn(LOG_PREFIX, "达到最大轮数 " + MAX_TOOL_ROUNDS + "，强制要求模型回复");
  conversation.push({
    role: "user",
    content: "请基于以上所有工具返回的信息，给出最终回复。不要继续调用工具。",
  });

  let finalReq: ChatRequest = {
    model: settings.model,
    messages: conversation,
    // 不传 temperature：不同型号约束不同，让厂商用默认值
    stream: false,
  };
  if (adapter.applyCacheHints) finalReq = adapter.applyCacheHints(finalReq, settings);
  const http = adapter.buildRequest(finalReq, settings);
  console.log(LOG_PREFIX, "请求:", http.url);

  const controller = new AbortController();
  // 强制总结是最后兜底：对话历史此时往往已很长，30s 不够模型生成完会被 abort，
  // 导致整个 run 抛错用户彻底没回复。放宽到 90s，且失败时降级返回已有工具结果。
  const timer = setTimeout(() => controller.abort(), FORCE_SUMMARY_TIMEOUT_MS);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      throw new Error("最终回复请求失败：HTTP " + response.status);
    }

    const data = await response.json();
    const chat = adapter.parseResponse(data);
    console.log(LOG_PREFIX, "强制回复完成，长度=" + chat.text.length);
    // 最终回复也记 usage
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1);
    }
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: chat.text, toolResults: allToolResults, totalUsage };
  } catch (err) {
    // 兜底再失败也别让整个 run 崩掉（抛错会让用户彻底没回复）。
    // 用已收集的工具结果拼一个"任务中断"文案降级返回。
    const reason = err instanceof Error && err.name === "AbortError"
      ? "总结请求超时"
      : (err instanceof Error ? err.message : String(err));
    console.error(LOG_PREFIX, "强制总结也失败，降级返回已有结果:", reason);
    const fallback = buildFallbackReply(allToolResults, reason);
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: fallback, toolResults: allToolResults, totalUsage };
  } finally {
    clearTimeout(timer);
  }
}
