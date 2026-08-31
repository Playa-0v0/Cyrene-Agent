/**
 * Learn 进度提取器 — 轻量结构化模型调用，从对话中提取学习进度增量。
 *
 * 策略：用最小的 budget（少量 messages + 低 maxTokens）调用模型，
 * 通过 json_schema structured output 直接返回结构化的进度更新。
 *
 * 不阻塞主回复，失败仅 log warn。
 */

import type { ChatMessage, ChatVendorAdapter } from "../../orchestrator/vendors/types";
import type { VendorConfig } from "../../orchestrator/vendors/types";
import { extractJsonCandidates } from "../../orchestrator/structured-output/json-candidates";
import type { LearnProgressUpdate } from "./learn-progress-types";

const EXTRACTOR_PROMPT = `你是一个学习进度追踪助手。根据以下对话，提取学习进度增量。

用户和 AI 助手刚完成了一轮教学对话。你需要判断这轮对话是否带来了有实质意义的学习进展，
如果是，提取相关的进度信息。

返回 JSON 格式：
{
  "hasMeaningfulChange": true,
  "topic": "正在学习的大主题（如 \"Transformer 架构\"）",
  "section": "当前具体章节或知识点（如 \"Self-Attention\"）",
  "masteryDelta": 10,
  "status": "learning",
  "unresolvedQuestionsAdded": ["用户刚提出的未解决问题"],
  "unresolvedQuestionsResolved": ["本回合已解决的问题"],
  "nextStep": "建议的下一步学习方向"
}

规则：
- 如果只是闲聊，没有实质学习进展，hasMeaningfulChange 设为 false
- masteryDelta 范围 -100 到 100，表示知识掌握度变化
- status 可选值：learning（学习中）、reviewing（复习中）、mastered（已掌握）
- 不要编造信息，只提取对话中确实出现的
`;

export interface ProgressExtractDeps {
  adapter: ChatVendorAdapter;
  cfg: VendorConfig;
  systemPrompt: string;
  userMessage: string;
  assistantMessage: string;
  modelId?: string;
}

/**
 * 从一轮教学对话中提取进度增量。
 * 失败返回 null，不抛异常。
 */
export async function extractProgress(
  deps: ProgressExtractDeps,
): Promise<LearnProgressUpdate | null> {
  try {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: deps.systemPrompt + "\n\n" + EXTRACTOR_PROMPT,
      },
      {
        role: "user",
        content: deps.userMessage,
      },
      {
        role: "assistant",
        content: deps.assistantMessage,
      },
    ];

    const request = deps.adapter.buildRequest(
      {
        model: deps.cfg.model,
        messages,
        maxTokens: 1024,
        temperature: 0.1,
        stream: false,
      },
      deps.cfg,
    );

    // 通过 HTTP 发起非流式调用
    const httpModule = require("http") as typeof import("http");
    const httpsModule = require("https") as typeof import("https");

    // adapter.buildRequest 已经把 body 序列化成 JSON 字符串，直接发送即可。
    const body = request.body;
    const url = new URL(request.url);
    const fetcher = url.protocol === "https:" ? httpsModule.request : httpModule.request;

    const response = await new Promise<{ status: number; data: string }>(
      (resolve, reject) => {
        const req = fetcher(
          {
            method: request.method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            headers: request.headers,
          },
          (res: import("http").IncomingMessage) => {
            let data = "";
            res.on("data", (chunk: Buffer) => (data += chunk.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 500, data }));
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      },
    );

    if (response.status !== 200) {
      console.warn(
        `[LearnProgress] 模型调用失败 HTTP ${response.status}: ${response.data.slice(0, 200)}`,
      );
      return null;
    }

    const parsed = deps.adapter.parseResponse(JSON.parse(response.data));
    if (!parsed.text?.trim()) return null;

    // 优先尝试 structuredValue，失败则从 text 提取 JSON
    if (parsed.structuredValue) {
      return validateUpdate(parsed.structuredValue);
    }

    const candidates = extractJsonCandidates(parsed.text);
    if (candidates.length > 0) {
      return validateUpdate(candidates[0].value);
    }

    return null;
  } catch (err) {
    console.warn("[LearnProgress] 进度提取失败：", err);
    return null;
  }
}

function validateUpdate(raw: unknown): LearnProgressUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  return {
    hasMeaningfulChange: obj.hasMeaningfulChange === true,
    topic: typeof obj.topic === "string" ? obj.topic : undefined,
    section: typeof obj.section === "string" ? obj.section : undefined,
    masteryDelta: typeof obj.masteryDelta === "number" ? obj.masteryDelta : undefined,
    status: ["learning", "reviewing", "mastered"].includes(String(obj.status))
      ? (obj.status as "learning" | "reviewing" | "mastered")
      : undefined,
    unresolvedQuestionsAdded: Array.isArray(obj.unresolvedQuestionsAdded)
      ? obj.unresolvedQuestionsAdded.filter((q) => typeof q === "string")
      : undefined,
    unresolvedQuestionsResolved: Array.isArray(obj.unresolvedQuestionsResolved)
      ? obj.unresolvedQuestionsResolved.filter((q) => typeof q === "string")
      : undefined,
    nextStep: typeof obj.nextStep === "string" ? obj.nextStep : undefined,
  };
}
