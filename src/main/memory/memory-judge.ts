import * as fs from "fs"
import * as path from "path"
import { getAdapterForConfig } from "../orchestrator/vendors"
import type { VendorConfig, ChatMessage } from "../orchestrator/vendors"
import { app } from "electron"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, MemoryJudgeTurn } from "./memory-types"
import { recordUsage } from "../token-usage-store"
import { revealSecrets } from "../security/secret-vault"

interface ModelSettings {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  explicitTransport?: "openai" | "anthropic" | "auto"
}

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
};

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json")
}

function loadModelSettings(): ModelSettings {
  try {
    const filePath = getSettingsPath()
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = revealSecrets(JSON.parse(raw)) as any
    const provider = typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : DEFAULT_MODEL_SETTINGS.provider
    const perProfile = parsed.perProvider && typeof parsed.perProvider === "object" ? parsed.perProvider[provider] : null
    
    const baseUrl = (perProfile?.baseUrl || parsed.baseUrl || DEFAULT_MODEL_SETTINGS.baseUrl).trim()
    const model = (perProfile?.model || parsed.model || DEFAULT_MODEL_SETTINGS.model).trim()
    const apiKey = (perProfile?.apiKey || parsed.apiKey || "").trim()
    const rawTransport = perProfile?.explicitTransport || parsed.explicitTransport
    const explicitTransport = rawTransport === "openai" || rawTransport === "anthropic" || rawTransport === "auto" ? rawTransport : undefined

    return {
      provider,
      baseUrl,
      model,
      apiKey,
      explicitTransport,
    }
  } catch {
    return DEFAULT_MODEL_SETTINGS
  }
}



function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function extractJsonArray(raw: string): unknown[] | null {
  // 第一步：去掉 markdown 代碼塊包裹 + think 塊
  let text = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  // 第二步：截取從第一個 [ 開始的內容（不要求結尾有 ]，防 max_tokens 截斷）
  const start = text.indexOf('[')
  if (start === -1) return null
  text = text.slice(start)

  // 第三步：直接嘗試解析（完整數組的情況）
  try {
    const parsed = JSON.parse(text) as unknown[]
    if (Array.isArray(parsed)) return parsed
  } catch (_) {}

  // 第四步：截斷救場 —— 即使末尾 ] 缺失，把已完整的 {...} 對象逐個撈出來。
  // 關鍵：用棧匹配大括號深度，避免把對象內部的 } 當成對象結束。
  const results: unknown[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue }
    // 找匹配的 } —— 跟蹤引號和嵌套深度
    let depth = 0
    let inStr = false
    let esc = false
    let j = i
    for (; j < text.length; j++) {
      const c = text[j]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) break  // 找到匹配的閉合
      }
    }
    if (depth !== 0) break  // 這個對象被截斷了，後面也不可能有完整的了
    const objStr = text.slice(i, j + 1)
    try {
      const obj = JSON.parse(objStr)
      if (obj && typeof obj === "object") results.push(obj)
    } catch (_) {
      // 單個對象解析失敗，跳過繼續找下一個
    }
    i = j + 1
  }

  if (results.length > 0) {
    console.log('[MemoryJudge] 截斷救場提取成功，條數:', results.length)
    return results
  }

  // 第五步：修復嵌套英文引號問題（針對完整數組的情況再試一次）
  try {
    // 給 text 補上缺失的 ] 讓 JSON.parse 有機會成功
    const fixedText = text.replace(/("content"|"triggerText"):\s*"([\s\S]*?)(?<!\\)"/g,
      (match: string, key: string, value: string) => {
        let k = 0
        const cleaned = value.replace(/"/g, () => k++ % 2 === 0 ? '「' : '」')
        return key + ': "' + cleaned + '"'
      }
    )
    // 嘗試找最後一個完整對象後補 ]
    const lastBrace = fixedText.lastIndexOf('}')
    if (lastBrace > 0) {
      const candidate = fixedText.slice(0, lastBrace + 1) + ']'
      const parsed = JSON.parse(candidate) as unknown[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch (_) {}

  return null
}

const ABSOLUTE_TERMS = ["只", "永遠", "從不", "一定", "完全", "絕對", "以後都", "不再"]

function hasUnsupportedAbsolute(summary: string, evidenceQuotes: string[]): boolean {
  return ABSOLUTE_TERMS.some((term) => summary.includes(term) && !evidenceQuotes.some((quote) => quote.includes(term)))
}

function normalizeCandidate(input: unknown): MemoryCandidate | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const layer = record.layer
  const summary = record.summary
  const importance = record.importance
  const stability = record.stability
  const certainty = record.certainty
  const attribution = record.attribution
  const evidenceQuotes = Array.isArray(record.evidenceQuotes) ? record.evidenceQuotes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []
  const contextSummary = record.contextSummary
  const shouldWrite = record.shouldWrite
  const reason = record.reason
  const forbiddenOverclaims = Array.isArray(record.forbiddenOverclaims) ? record.forbiddenOverclaims.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []
  if (layer !== "L0" && layer !== "L1" && layer !== "L2") return null
  if (typeof summary !== "string" || !summary.trim()) return null
  if (importance !== "low" && importance !== "medium" && importance !== "high") return null
  if (stability !== "one_off" && stability !== "situational" && stability !== "stable") return null
  if (certainty !== "explicit" && certainty !== "inferred" && certainty !== "uncertain") return null
  if (attribution !== "user_explicit" && attribution !== "assistant_inferred" && attribution !== "mixed") return null
  if (shouldWrite !== true) return null
  if (typeof contextSummary !== "string" || !contextSummary.trim()) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  if (evidenceQuotes.length === 0) return null
  if (forbiddenOverclaims.length > 0) return null
  if (hasUnsupportedAbsolute(summary, evidenceQuotes)) return null

  const confidence =
    certainty === "explicit" ? 0.9 :
    certainty === "inferred" ? 0.65 :
    0.4
  return {
    layer,
    field: typeof record.field === 'string' ? record.field : undefined,
    summary: summary.trim(),
    content: summary.trim(),
    confidence,
    triggerText: evidenceQuotes[0],
    importance,
    stability,
    certainty,
    attribution,
    evidenceQuotes,
    contextSummary: contextSummary.trim(),
    shouldWrite,
    reason: reason.trim(),
    forbiddenOverclaims,
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

  // 拼 VendorConfig（settings 頂層三件套 + 鏡像字段都參與）
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  }

  try {
    // adapter 三層 transport 解析（explicitTransport → baseUrl 啟發式 → capabilities fallback）
    // —— 之前直接寫 OpenAI body / Bearer header / choices[0].message.content 解析，
    // 切到 anthropic transport 廠商（如 MiniMax / Claude）時會拿到空字符串，誤判 "JSON 解析失敗"。
    // 現在交給 adapter，OpenAI / Anthropic 端點都正確。
    const adapter = getAdapterForConfig(cfg)
    const http = adapter.buildRequest({
      model: cfg.model,
      messages: messages as ChatMessage[],
      maxTokens: 800,
      stream: false,
    }, cfg)

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>
      const errMsg = (errorData as { error?: { message?: string } }).error?.message
      throw new Error(errMsg || `模型請求失敗：HTTP ${response.status}`)
    }

    const data = await response.json()
    const parsed = adapter.parseResponse(data)

    // 記錄 token 用量（統一字段，OpenAI / Anthropic adapter 都映射成 {input, output}）
    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1, settings.model)
    }
    return stripThinkBlocks(parsed.text ?? "")
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
  async judgeRecentTurns(
    turns: MemoryJudgeTurn[],
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    console.log(`[MemoryJudge] 分析最近 ${turns.length} 輪對話...`)

    try {
      const settings = loadModelSettings()
      if (!settings.apiKey) {
        console.error("[MemoryJudge] LLM 調用失敗: missing api key")
        console.log("[MemoryJudge] 本輪無值得記錄的信息")
        return []
      }

      const systemPrompt = [
        "你是一個保守的記憶候選提取器，不是事實裁判，也不是用戶畫像改寫器。",
        "你的目標是少記錯，不是多記住。",
        "",
        "你只能提取用戶明確表達、且未來確實有幫助的信息候選。",
        "禁止把推斷寫成確定事實；禁止把一次性狀態寫成長期偏好；禁止為了輸出而輸出。",
        "如果最近這些對話沒有值得記的內容，必須返回空數組 []。",
        "",
        "記憶層級定義：",
        "- L0：用戶穩定身份信息或核心畫像。只有 certainty=explicit 且 attribution=user_explicit 才允許進入 L0。",
        "  識別到 L0 信息時，必須同時在 field 字段裡指定要寫入哪個格子。",
        "  可用的 field 值如下（只能用這些，不能自己發明）：",
        this.buildL0FieldPrompt(),
        "",
        "  重要：field 的值必須嚴格是上方列出的英文字段名，",
        "  例如 preferredName、occupation，",
        "  不能用 nickname、name、job 等其他詞。",
        "- L1：用戶近期目標或階段性偏好，只能寫近期狀態，不要寫成長期偏好。",
        "- L2：具體事件、經歷、局部偏好、情緒背景、待觀察信息。",
        "",
        "判斷原則：",
        "- 寧可漏記，不要誤記",
        "- 純日常問候、閒聊、情緒發洩（無信息量）→ 返回空數組",
        "- 必須是用戶主動表達的信息，不是 AI 說的",
        "- summary 必須忠於用戶原話和上下文，不要自行推廣範圍",
        "- 如果只是 AI 的建議、安慰、總結、推斷，不要寫成用戶事實",
        "- 不要把「這次」「剛剛」「這個話題裡」變成長期偏好",
        "- 不要自動使用絕對化表達：只、永遠、從不、一定、完全、絕對、以後都、不再，除非用戶原話明確說過這些詞",
        "- 如果 summary 中存在可能過度概括的詞，必須寫入 forbiddenOverclaims；有 forbiddenOverclaims 時 shouldWrite 必須是 false",
        "",
        "重要格式規則：",
        "- summary 和 evidenceQuotes 字段的值裡，禁止出現英文雙引號 \"",
        "- 如果內容裡有引號，統一用中文引號「」替代，例如：用戶希望被稱為「寶寶」",
        "- 不要用 markdown 代碼塊包裹 JSON，直接輸出裸 JSON",
        "- 數組第一個字符必須是 [，最後一個字符必須是 ]",
        "",
        "輸出格式為 JSON 數組，禁止用 markdown 代碼塊包裹，直接輸出裸 JSON。",
        "",
        "每個候選必須包含這些字段：",
        "{",
        "  \"layer\": \"L0\",",
        "  \"field\": \"preferredName\",",
        "  \"summary\": \"保守、可追溯的候選摘要\",",
        "  \"importance\": \"low|medium|high\",",
        "  \"stability\": \"one_off|situational|stable\",",
        "  \"certainty\": \"explicit|inferred|uncertain\",",
        "  \"attribution\": \"user_explicit|assistant_inferred|mixed\",",
        "  \"evidenceQuotes\": [\"用戶原話短引文，必須來自用戶\"],",
        "  \"contextSummary\": \"最近多輪上下文概括，不超過80字\",",
        "  \"shouldWrite\": true,",
        "  \"reason\": \"為什麼值得記，或為什麼不寫\",",
        "  \"forbiddenOverclaims\": []",
        "}",
        "",
        "L1/L2 不需要 field。",
        "inferred / uncertain 不允許進入 L0；如果還值得保留，只能放 L2，或者 shouldWrite=false。",
        "沒有值得記錄的信息時，輸出：[]",
        "summary 和 evidenceQuotes 裡禁止出現英文雙引號，用「」替代。",
      ].join("\n")

      const transcript = turns.map((turn, index) => [
        `第 ${index + 1} 輪：`,
        `用戶：${turn.userInput}`,
        `AI：${turn.assistantReply}`,
      ].join("\n")).join("\n\n")

      const userPrompt = [
        `conversationId: ${conversationId}`,
        "最近對話：",
        transcript,
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
        console.error("[MemoryJudge] JSON 解析失敗，原始內容：\n", raw.slice(0, 200))
        console.log("[MemoryJudge] 本輪無值得記錄的信息")
        return []
      }

      const candidates = parsed
        .map(normalizeCandidate)
        .filter((item): item is MemoryCandidate => item !== null)
        .filter((item) => item.shouldWrite === true)
        .filter((item) => item.layer !== "L0" || (item.certainty === "explicit" && item.attribution === "user_explicit"))

      if (candidates.length === 0) {
        console.log("[MemoryJudge] 本輪無值得記錄的信息")
        return []
      }

      console.log(`[MemoryJudge] 提取候選: ${candidates.length} 條（過濾後）`)
      console.log(
        `[MemoryJudge] 候選詳情: ${candidates.map((item) => item.layer === "L0" && item.field ? `${item.layer}.${item.field}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})` : `${item.layer}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})`).join(" ")}`,
      )
      return candidates
    } catch (error) {
      console.error("[MemoryJudge] LLM 調用失敗:", error)
      console.log("[MemoryJudge] 本輪無值得記錄的信息")
      return []
    }
  }

  async judge(
    userMessage: string,
    assistantMessage: string,
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    return this.judgeRecentTurns([{ userInput: userMessage, assistantReply: assistantMessage }], conversationId)
  }
}

export const memoryJudge = new MemoryJudge()
