import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, MemoryJudgeTurn } from "./memory-types"
import { invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client"
import { loadMemoryModelConfig } from "./memory-llm-shared"
import { parseMemoryJudgeResult, validateMemoryJudgeBusiness, MemoryJudgeResult } from "./memory-schemas"

const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"]

function hasUnsupportedAbsolute(summary: string, evidenceQuotes: string[]): boolean {
  return ABSOLUTE_TERMS.some((term) => summary.includes(term) && !evidenceQuotes.some((quote) => quote.includes(term)))
}

/**
 * 业务级后处理：过滤不符合条件的候选。
 * 这些规则是 Memory Judge 的业务语义，不是 schema 校验。
 */
function postFilterCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return candidates
    .filter((item) => item.shouldWrite === true)
    .filter((item) => item.layer !== "L0" || (item.certainty === "explicit" && item.attribution === "user_explicit"))
    .filter((item) => !item.forbiddenOverclaims || item.forbiddenOverclaims.length === 0)
    .filter((item) => !hasUnsupportedAbsolute(item.summary ?? item.content, item.evidenceQuotes ?? []))
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
  ): Promise<MemoryJudgeResult> {
    console.log(`[PMRS/Judge] 分析最近 ${turns.length} 轮对话...`)

    try {
      const config = loadMemoryModelConfig()
      if (!config.apiKey) {
        console.error("[PMRS/Judge] LLM 调用失败: missing api key")
        console.log("[PMRS/Judge] 本轮无值得记录的信息")
        return { candidates: [], entities: [] }
      }

      const systemPrompt = [
        "你是一个保守的记忆候选提取器，不是事实裁判，也不是用户画像改写器。",
        "你的目标是少记错，不是多记住。",
        "",
        "你只能提取用户明确表达、且未来确实有帮助的信息候选。",
        "禁止把推断写成确定事实；禁止把一次性状态写成长期偏好；禁止为了输出而输出。",
        "如果最近这些对话没有值得记的内容，必须返回 {\"candidates\":[]}。",
        "",
        "PMRS 层级定义：",
        "- 画像 (L0)：用户稳定身份信息或核心画像。只有 certainty=explicit 且 attribution=user_explicit 才允许进入画像。",
        "  识别到画像信息时，必须同时在 field 字段里指定要写入哪个格子。",
        "  可用的 field 值如下（只能用这些，不能自己发明）：",
        this.buildL0FieldPrompt(),
        "",
        "  重要：field 的值必须严格是上方列出的英文字段名，",
        "  例如 preferredName、occupation，",
        "  不能用 nickname、name、job 等其他词。",
        "- 近况 (L1)：用户近期目标或阶段性偏好，只能写近期状态，不要写成长期偏好。",
        "  识别到近况信息时，必须在 field 字段指定写入哪个格子，可用值：recentGoals / recentPreferences / currentProject。",
        "- 片段 (L2)：具体事件、经历、局部偏好、情绪背景、待观察信息。",
        "",
        "判断原则：",
        "- 宁可漏记，不要误记",
        "- 纯日常问候、闲聊、情绪发泄（无信息量）→ 返回 {\"candidates\":[]}",
        "- 必须是用户主动表达的信息，不是 AI 说的",
        "- summary 必须忠于用户原话和上下文，不要自行推广范围",
        "- 如果只是 AI 的建议、安慰、总结、推断，不要写成用户事实",
        "- 不要把「这次」「刚刚」「这个话题里」变成长期偏好",
        "- 不要自动使用绝对化表达：只、永远、从不、一定、完全、绝对、以后都、不再，除非用户原话明确说过这些词",
        "- 如果 summary 中存在可能过度概括的词，必须写入 forbiddenOverclaims；有 forbiddenOverclaims 时 shouldWrite 必须是 false",
        "",
        "重要格式规则：",
        "- summary 和 evidenceQuotes 字段的值里，禁止出现英文双引号 \"",
        "- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
        "- 输出必须是顶层 JSON 对象，顶层字段为 candidates 和 entities",
        "- candidates 的值必须是 JSON 数组",
        "",
        "实体抽取（与候选一起输出，复用本次调用，不额外开销）：",
        "- 只抽用户明确提到的、有指代价值的命名实体（人物名/地名/机构名/具体偏好对象/具体概念）",
        "- 实体类型只能是：person（人物）/ place（地点）/ concept（概念）/ preference（偏好）/ organization（组织）",
        "- 禁止抽取聊天碎片：标点、引号、emoji、语气词、单字、代词、感叹词、对话子串",
        "- 如果只是 AI 提到的、或用户随口一带没有指代价值的，不要抽",
        "- aliases 字段：该实体的其他叫法（可选，没有就省略）",
        "- 没有值得记录的实体时，entities 返回空数组 []",
        "",
        "L2 slug 抽取（与候选一起输出，复用本次调用，不额外开销）：",
        "- L2 候选必须输出 slug 字段：精炼的记忆标题，将作为 Obsidian 文件名与双链锚点",
        "- 规则：≤20 字；只能含中文/英文字母/数字/下划线/连字符；禁止标点、引号、空格、emoji",
        "- slug 应高度概括本条记忆的主题，不要直接复用 summary 全文",
        "- 示例：用户说喜欢吃香菇 → slug=\"喜欢香菇\"；和小张约下周吃饭 → slug=\"和小张约饭\"；React Chat 窗口迁移 → slug=\"ReactChat迁移\"",
        "- L0 / L1 候选不要输出 slug 字段",
        "",
        "L2 sourceQuote 抽取（与候选一起输出，复用本次调用，不额外开销）：",
        "- L2 候选必须输出 sourceQuote 字段：从最近对话里挑出最有信息量的一段原文片段（用户或对话原话）",
        "- 目的：L2 是浓缩结论，会丢失字面信息（专有名词/数字/代码片段）；sourceQuote 保留「用户当时说的原话」，召回时让后续模型看到字面证据",
        "- 规则：软上限 500 字；不要整段照抄对话；优先挑含专有名词、数字、代码、关键名词的句子；允许标点、空格、emoji（因为是原文）",
        "- 不要把 summary 复制进 sourceQuote；sourceQuote 应是原话片段，summary 是你的浓缩结论",
        "- 示例：用户说「我用 React 18.2 做的前端，部署在 vercel 上」→ sourceQuote=\"我用 React 18.2 做的前端，部署在 vercel 上\"",
        "- L0 / L1 候选不要输出 sourceQuote 字段",
        "",
        "输出结构：",
        "{",
        "  \"candidates\": [",
        "    {",
        "      \"layer\": \"L0\",",
        "      \"field\": \"preferredName\",",
        "      \"summary\": \"保守、可追溯的候选摘要\",",
        "      \"slug\": \"L2精炼标题\",",
        "      \"sourceQuote\": \"L2原文对话片段\",",
        "      \"content\": \"与 summary 相同\",",
        "      \"confidence\": 0.9,",
        "      \"triggerText\": \"用户原话短引文\",",
        "      \"importance\": \"low|medium|high\",",
        "      \"stability\": \"one_off|situational|stable\",",
        "      \"certainty\": \"explicit|inferred|uncertain\",",
        "      \"attribution\": \"user_explicit|assistant_inferred|mixed\",",
        "      \"evidenceQuotes\": [\"用户原话短引文，必须来自用户\"],",
        "      \"contextSummary\": \"最近多轮上下文概括，不超过80字\",",
        "      \"shouldWrite\": true,",
        "      \"reason\": \"为什么值得记，或为什么不写\",",
        "      \"forbiddenOverclaims\": []",
        "    }",
        "  ],",
        "  \"entities\": [",
        "    {\"name\": \"小张\", \"type\": \"person\", \"aliases\": [\"张三\"]}",
        "  ]",
        "}",
        "",
        "片段不需要 field。近况必须指定 field（recentGoals / recentPreferences / currentProject）。",
        "L2 片段必须输出 slug 字段（精炼标题，≤20 字，仅中文/字母/数字/_/-），如 \"slug\": \"喜欢香菇\"。",
        "L2 片段必须输出 sourceQuote 字段（原文对话片段，≤500 字，允许标点/空格/emoji），如 \"sourceQuote\": \"我用 React 18.2 做的前端\"。",
        "inferred / uncertain 不允许进入画像；如果还值得保留，只能放片段，或者 shouldWrite=false。",
        "没有值得记录的信息时，输出：{\"candidates\":[],\"entities\":[]}",
        "summary 和 evidenceQuotes 里禁止出现英文双引号，用「」替代。",
        "实体 name 也禁止包含英文双引号、标点、emoji。",
        "slug 禁止包含标点、引号、空格、emoji；只能含中文/字母/数字/下划线/连字符。",
      ].join("\n")

      const transcript = turns.map((turn, index) => [
        `第 ${index + 1} 轮：`,
        `用户：${turn.userInput}`,
        `AI：${turn.assistantReply}`,
      ].join("\n")).join("\n\n")

      const userPrompt = [
        `conversationId: ${conversationId}`,
        "最近对话：",
        transcript,
      ].join("\n")

      const result = await invokeMemoryStructuredOutput<MemoryJudgeResult>({
        operation: "judge",
        systemPrompt,
        userPrompt,
        maxOutputTokens: getDefaultMaxOutputTokens("judge"),
        parseSchema: parseMemoryJudgeResult,
        validateBusiness: validateMemoryJudgeBusiness,
        config,
      })

      const filtered = postFilterCandidates(result.candidates)

      // 注入来源会话 ID，供 L2 回溯使用（LLM 不负责输出此字段）
      for (const candidate of filtered) {
        candidate.sourceConversationId = conversationId
      }

      console.log(`[PMRS/Judge] 提取候选: ${filtered.length} 条（过滤后），实体: ${result.entities.length} 个`)
      console.log(
        `[PMRS/Judge] 候选详情: ${filtered.map((item) => item.layer === "L0" && item.field ? `${item.layer}.${item.field}(\"${(item.summary ?? item.content).slice(0, 20)}\", ${item.confidence.toFixed(2)})` : `${item.layer}(\"${(item.summary ?? item.content).slice(0, 20)}\", ${item.confidence.toFixed(2)})`).join(" ")}`,
      )
      return { candidates: filtered, entities: result.entities }
    } catch (error) {
      console.error("[PMRS/Judge] LLM 调用失败:", error)
      console.log("[PMRS/Judge] 本轮无值得记录的信息")
      return { candidates: [], entities: [] }
    }
  }

  async judge(
    userMessage: string,
    assistantMessage: string,
    conversationId: string,
  ): Promise<MemoryJudgeResult> {
    return this.judgeRecentTurns([{ userInput: userMessage, assistantReply: assistantMessage }], conversationId)
  }
}

export const memoryJudge = new MemoryJudge()
