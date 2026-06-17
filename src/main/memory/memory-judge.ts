import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS } from "./memory-types"

interface ModelSettings {
  baseUrl: string
  model: string
  apiKey: string
}

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
}

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json")
}

function loadModelSettings(): ModelSettings {
  try {
    const filePath = getSettingsPath()
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<ModelSettings>
    return {
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_MODEL_SETTINGS.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
    }
  } catch {
    return DEFAULT_MODEL_SETTINGS
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function extractJsonArray(raw: string): unknown[] | null {
  // 第一步：去掉 markdown 代码块包裹
  let text = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  // 第二步：截取第一个 [ 到最后一个 ] 之间的内容
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  text = text.slice(start, end + 1)

  // 第三步：直接尝试解析
  try {
    return JSON.parse(text) as unknown[]
  } catch (_) {}

  // 第四步：修复嵌套英文引号问题
  try {
    const fixed = text.replace(
      /("content"|"triggerText"):\s*"([\s\S]*?)(?<!\\)"/g,
      (match: string, key: string, value: string) => {
        let i = 0
        const cleaned = value.replace(/"/g, () => i++ % 2 === 0 ? '「' : '」')
        return key + ': "' + cleaned + '"'
      }
    )
    return JSON.parse(fixed) as unknown[]
  } catch (_) {}

  // 第五步：最后兜底，用正则逐字段提取
  try {
    const results: unknown[] = []
    const itemRegex = /\{[\s\S]*?\}/g
    const items = text.match(itemRegex) || []
    for (const item of items) {
      const layer = item.match(/"layer"\s*:\s*"([^"]+)"/)
      const content = item.match(/"content"\s*:\s*"([\s\S]+?)"(?:\s*,|\s*\})/)
      const confidence = item.match(/"confidence"\s*:\s*([\d.]+)/)
      const triggerText = item.match(/"triggerText"\s*:\s*"([\s\S]+?)"(?:\s*,|\s*\})/)
      if (layer && content && confidence) {
        results.push({
          layer: layer[1],
          content: content[1],
          confidence: parseFloat(confidence[1]),
          triggerText: triggerText ? triggerText[1] : content[1].slice(0, 30)
        })
      }
    }
    if (results.length > 0) {
      console.log('[MemoryJudge] 使用兜底正则提取成功，条数:', results.length)
      return results
    }
  } catch (_) {}

  return null
}

function normalizeCandidate(input: unknown): MemoryCandidate | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const layer = record.layer
  const content = record.content
  const confidence = record.confidence
  const triggerText = record.triggerText
  if (layer !== "L0" && layer !== "L1" && layer !== "L2") return null
  if (typeof content !== "string" || !content.trim()) return null
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null
  if (typeof triggerText !== "string" || !triggerText.trim()) return null
  return {
    layer,
    field: typeof record.field === 'string' ? record.field : undefined,
    content: content.trim(),
    confidence,
    triggerText: triggerText.trim(),
  }
}

async function callChatCompletions(
  settings: ModelSettings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(buildChatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.2,
        max_tokens: 300,
        stream: false,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>
      const errMsg = (errorData as { error?: { message?: string } }).error?.message
      throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`)
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ""
    return stripThinkBlocks(content)
  } finally {
    clearTimeout(timer)
  }
}

export class MemoryJudge {
  private buildL0FieldPrompt(): string {
    return Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, description]) => `  · ${field}：${description}`)
      .join('\n')
  }
  async judge(
    userMessage: string,
    assistantMessage: string,
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    console.log("[MemoryJudge] 分析本轮对话...")

    try {
      const settings = loadModelSettings()
      if (!settings.apiKey) {
        console.error("[MemoryJudge] LLM 调用失败: missing api key")
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      const systemPrompt = [
        "你是一个记忆提取器，分析对话内容，判断是否有值得长期记住的信息。",
        "",
        "记忆层级定义：",
        "- L0：用户的稳定身份信息。",
        "  识别到 L0 信息时，必须同时在 field 字段里指定要写入哪个格子。",
        "  可用的 field 值如下（只能用这些，不能自己发明）：",
        this.buildL0FieldPrompt(),
        "",
        "  重要：field 的值必须严格是上方列出的英文字段名，",
        "  例如 preferredName、occupation，",
        "  不能用 nickname、name、job 等其他词。",
        "- L1：用户近期目标或阶段性偏好（最近想做什么、近期关注什么）",
        "- L2：具体事件或情绪经历（今天发生了什么、某件具体的事）",
        "",
        "判断原则：",
        "- 宁可漏记，不要误记",
        "- 纯日常问候、闲聊、情绪发泄（无信息量）→ 返回空数组",
        "- 必须是用户主动表达的信息，不是 AI 说的",
        "- 提炼信息，不要复制原文",
        "",
        "重要格式规则：",
        "- content 和 triggerText 字段的值里，禁止出现英文双引号 \"",
        "- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
        "- 不要用 markdown 代码块包裹 JSON，直接输出裸 JSON",
        "- 数组第一个字符必须是 [，最后一个字符必须是 ]",
        "",
        "输出格式为 JSON 数组，禁止用 markdown 代码块包裹，直接输出裸 JSON。",
        "",
        "L0 候选（必须包含 field）：",
        "{",
        "  \"layer\": \"L0\",",
        "  \"field\": \"preferredName\",",
        "  \"content\": \"提炼后的内容，用「」代替引号\",",
        "  \"confidence\": 0.0~1.0,",
        "  \"triggerText\": \"原始触发文本，不超过50字，用「」代替引号\"",
        "}",
        "",
        "L1 候选（不需要 field）：",
        "{",
        "  \"layer\": \"L1\",",
        "  \"content\": \"提炼后的内容\",",
        "  \"confidence\": 0.0~1.0,",
        "  \"triggerText\": \"原始触发文本\"",
        "}",
        "",
        "L2 候选（不需要 field）：",
        "{",
        "  \"layer\": \"L2\",",
        "  \"content\": \"提炼后的内容\",",
        "  \"confidence\": 0.0~1.0,",
        "  \"triggerText\": \"原始触发文本\"",
        "}",
        "",
        "没有值得记录的信息时，输出：[]",
        "content 和 triggerText 里禁止出现英文双引号，用「」替代。",
      ].join("\n")

      const userPrompt = [
        `conversationId: ${conversationId}`,
        `用户说：${userMessage}`,
        `AI回复：${assistantMessage}`,
      ].join("\n")

      const raw = await callChatCompletions(
        settings,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        30000,
        "MemoryJudge",
      )

      const parsed = extractJsonArray(raw)
      if (!parsed) {
        console.error("[MemoryJudge] JSON 解析失败，原始内容：\n", raw.slice(0, 200))
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      const candidates = parsed
        .map(normalizeCandidate)
        .filter((item): item is MemoryCandidate => item !== null)
        .filter((item) => item.confidence >= 0.7)

      if (candidates.length === 0) {
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      console.log(`[MemoryJudge] 提取候选: ${candidates.length} 条（过滤后）`)
      console.log(
        `[MemoryJudge] 候选详情: ${candidates.map((item) => item.layer === "L0" && item.field ? `${item.layer}.${item.field}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})` : `${item.layer}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})`).join(" ")}`,
      )
      return candidates
    } catch (error) {
      console.error("[MemoryJudge] LLM 调用失败:", error)
      console.log("[MemoryJudge] 本轮无值得记录的信息")
      return []
    }
  }
}

export const memoryJudge = new MemoryJudge()
