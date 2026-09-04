/**
 * long-term-memory 示例：轮次事件 + 冻结分页 + LLM + Prompt Provider。
 *
 * 展示四个知识点：
 * 1. 监听 host:turn:finished 事件，用 source 字段收窄出桌面分支的
 *    inputMessageId / finalMessageId
 * 2. 把这对 id 直接作为 fromMessageId / throughMessageId 传入
 *    getMessages() 冻结读取范围：翻页不会混入后续轮次的消息
 * 3. deps 声明 llm，用 ctx.deps.llm 生成本轮对话摘要
 * 4. registerPromptProvider 把最近摘要注入下一轮动态上下文（只写事实，短而精）
 */
import type {
  CyrenePlugin,
  PluginConversationMessage,
  PluginDeps,
  PluginTool,
  PluginTurnFinishedEvent,
} from "@playa0v0/cyrene-plugin-sdk";

/** 每个会话保留最近几条摘要。 */
const MAX_MEMORIES_PER_CONVERSATION = 5;

let deps: PluginDeps = {};
/** conversationId → 最近摘要（最新在后）。 */
let memories = new Map<string, string[]>();

/** 把一轮对话压缩成一句话摘要；LLM 失败时降级为截断原文。 */
async function summarize(messages: PluginConversationMessage[]): Promise<string | null> {
  if (messages.length === 0) return null;
  const transcript = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.text}`)
    .join("\n")
    .slice(0, 4000);
  try {
    return await deps.llm!.generateText(
      [
        { role: "system", content: "用一句不超过 50 字的中文总结这轮对话的关键事实或决定。" },
        { role: "user", content: transcript },
      ],
      { maxTokens: 128, purpose: "summarize-turn" },
    );
  } catch {
    // LLM 不可用时降级：保留用户消息前 50 字
    const firstUser = messages.find((m) => m.role === "user");
    return firstUser ? `（未摘要）${firstUser.text.slice(0, 50)}` : null;
  }
}

function remember(conversationId: string, summary: string): void {
  const list = memories.get(conversationId) ?? [];
  list.push(summary);
  while (list.length > MAX_MEMORIES_PER_CONVERSATION) list.shift();
  memories.set(conversationId, list);
}

const recallTool: PluginTool = {
  id: "long-term-memory_recall",
  name: "回忆最近对话",
  description: "查看指定会话的最近记忆摘要。参数 conversationId 为会话 id；省略时查看所有会话的记忆条数。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  inputSchema: {
    type: "object",
    properties: {
      conversationId: { type: "string", description: "会话 id，省略时返回全部会话的记忆统计" },
    },
  },
  async execute(args) {
    const conversationId = String(args.conversationId ?? "");
    if (conversationId) {
      const list = memories.get(conversationId) ?? [];
      if (list.length === 0) return "该会话暂无记忆";
      return list.map((s, i) => `${i + 1}. ${s}`).join("\n");
    }
    const stats = [...memories.entries()].map(([id, list]) => `${id}: ${list.length} 条`);
    return stats.length > 0 ? stats.join("\n") : "暂无任何记忆";
  },
};

const plugin: CyrenePlugin = {
  async register(ctx) {
    deps = ctx.deps;

    // 恢复历史记忆（storage 演示：跨启停持久化）
    memories = ctx.storage.get<Map<string, string[]>>("memories") ?? new Map();
    ctx.onDispose(() => {
      ctx.storage.set("memories", memories);
    });

    // 轮次结束：冻结边界读取本轮消息并生成摘要
    ctx.events.on("host:turn:finished", async (event: PluginTurnFinishedEvent) => {
      if (event.source !== "desktop" || event.status !== "success") return;
      const conversations = deps.conversations;
      if (!conversations || !event.inputMessageId) return;

      // 用 inputMessageId / finalMessageId 冻结读取范围：翻页不会混入后续轮次
      const page = await conversations.getMessages({
        conversationId: event.conversationId,
        fromMessageId: event.inputMessageId,
        throughMessageId: event.finalMessageId,
        limit: 50,
      });
      const summary = await summarize(page.items);
      if (summary) remember(event.conversationId, summary);
    });

    // 动态提示词：只注入事实性状态，不写指令性内容
    ctx.registerPromptProvider({
      id: "recent-memories",
      provide(input) {
        if (input.source !== "conversation") return "";
        const list = memories.get(input.conversationId ?? "");
        if (!list || list.length === 0) return "";
        const recent = list.slice(-3).map((s) => `- ${s}`).join("\n");
        return `[长期记忆] 该会话最近摘要:\n${recent}`;
      },
    });

    ctx.registerTool(recallTool);
  },
  unregister() {
    memories = new Map();
  },
};

export = plugin;
