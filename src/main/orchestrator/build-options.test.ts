import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAgentRunOptions,
  buildChannelSystem,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options"

function createBuildDeps(): BuildOptionsDeps {
  return {
    loadModelSettings: () => ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "ENV",
    buildSkillCatalog: () => "",
    skillRegistry: { getEnabled: () => [] },
    resolveSlashActivation: () => "",
    buildToneInjection: async () => "",
    sceneEmbeddingIndex: null,
    getSceneEmbeddingProvider: () => null,
    buildAlwaysOnContext: async () => "ALWAYS",
    buildRelationshipContext: async () => "RELATIONSHIP",
    buildSystemPrompt: () => "BASE_SYSTEM",
    buildToolSystemPrompt: () => "TOOL_SYSTEM",
    buildSoulSystemBasePrompt: () => "SOUL_SYSTEM_BASE",
    toolRegistry: { getEnabled: () => [] },
    logWorldbookInjection: () => {},
    normalizeChatMessages: (raw) => raw as never,
    chatRequestTimeoutMs: 1000,
  }
}

describe("build-options", () => {
  it("adds a concise WeChat system when the run comes from WeChat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
      channel: "wechat",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
    expect(result.options.soulSystemBaseContent).toContain("RELATIONSHIP")
    expect(result.options.toolSystemContent).toBe("TOOL_SYSTEM")
  })

  it("does not add channel system for desktop chat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过飞书回复用户")
  })

  it("messages 不含 system，FC 循环按阶段动态注入", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    // 第一期：原始 messages 不含 system 消息
    expect(result.options.messages.some((m) => m.role === "system")).toBe(false)
  })

  it("adds message timestamps and one gap notice to AG-UI chat context", async () => {
    const deps = createBuildDeps()
    deps.loadUserProfile = () => ({ timezone: "Asia/Taipei" })

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "今天有点累", at: Date.UTC(2026, 6, 12, 12, 0) },
        { role: "assistant", content: "早点休息", at: Date.UTC(2026, 6, 12, 12, 2) },
        { role: "user", content: "我回来啦", at: Date.UTC(2026, 6, 13, 3, 0) },
      ],
      style: "01_default.md",
    }, deps)

    expect(result.options.messages[0].content).toBe("[2026-07-12 20:00, Asia/Taipei]\n今天有点累")
    expect(result.options.messages[2].content).toBe("[2026-07-13 11:00, Asia/Taipei]\n我回来啦")
    expect(result.options.soulSystemBaseContent).toContain("[对话时间信息]")
    expect(result.options.soulSystemBaseContent).toContain("距离上一条有效聊天消息：约 14 小时 58 分钟")
    expect(result.options.soulSystemBaseContent.match(/距离上一条有效聊天消息/g)).toHaveLength(1)
    expect(result.options.toolSystemContent).not.toContain("[对话时间信息]")
  })

  it("toolSystemContent / soulSystemBaseContent 是分开的两套字符串", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.toolSystemContent).toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).not.toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
  })

  it("attaches direct image content blocks to the latest user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-direct-"))
    const imagePath = path.join(dir, "图 像.png")
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]))

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "请看这张图" },
      ],
      style: "01_default.md",
      imageAttachments: [{ name: "图 像.png", filePath: imagePath, mime: "image/png" }],
    }, createBuildDeps())

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "请看这张图" },
      {
        type: "image_url",
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ])
    // 第一期：原始 messages 不含 system，所以 messages[0] 就是首条用户消息
    expect(result.options.messages[0].content).toBe("上一轮")
  })

  it("builds caption fallback messages for direct image send failures", async () => {
    const deps = createBuildDeps()
    deps.captionImageForFallback = async () => ({ ok: true, caption: "画面里有一张安装截图" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这图哪里不对？" }],
      style: "01_default.md",
      imageAttachments: [{ name: "setup.png", filePath: "C:\\tmp\\setup.png", mime: "image/png" }],
    }, deps)

    const fallbackMessages = await result.options.imageCaptionFallback?.()
    const userMessage = fallbackMessages?.at(-1)
    expect(userMessage?.content).toContain("这图哪里不对？")
    expect(userMessage?.content).toContain("setup.png：画面里有一张安装截图")
    expect(userMessage?.content).not.toContain("image_url")
  })

  it("has distinct system text for Feishu work chat", () => {
    expect(buildChannelSystem("feishu")).toContain("你正在通过飞书回复用户")
    expect(buildChannelSystem("feishu")).toContain("工作上下文")
  })

  it("records relationship turn after agent run finishes", async () => {
    const recordRelationshipTurn = vi.fn(async () => {})
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "off" }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn,
      getChatWindow: () => null,
    }

    await onAgentRunFinished({ reply: "好呀", toolResults: [] }, "今天有点累", deps, "wechat")

    expect(recordRelationshipTurn).toHaveBeenCalledWith({
      userText: "今天有点累",
      assistantText: "好呀",
      cyreneFeeling: "温柔",
      channel: "wechat",
    })
  })

  it("uses the latest sticker embedding index when agent run finishes", async () => {
    const matchSticker = vi.fn(async () => ({ id: "hugtight" }))
    const send = vi.fn()
    const latestIndex = [{ id: "hugtight", embedding: [1, 0] }]
    const deps: OnRunFinishedDeps & { getStickerEmbeddingIndex: () => unknown } = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getStickerEmbeddingIndex: () => latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
      getChatWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send,
        },
      }),
    }

    await onAgentRunFinished({ reply: "来，抱抱你", toolResults: [] }, "今天好累", deps)

    expect(matchSticker).toHaveBeenCalledWith(
      "来，抱抱你\n今天好累",
      expect.anything(),
      latestIndex,
      0.55,
    )
    expect(send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      name: "cyrene.sticker",
      value: "hugtight",
    }))
  })

  it("does not send document model context into memory or sticker embedding side effects", async () => {
    const scheduleMemoryWrite = vi.fn()
    const matchSticker = vi.fn(async () => null)
    const latestIndex = [{ id: "thinking", embedding: [1, 0] }]
    const hugeDoc = "超长文档内容".repeat(1000)
    const latestUserText = [
      "帮我总结这个 md",
      "【本轮文件】\n📝 notes.md（附件，内容已注入本轮上下文）",
      `【文档内容】\n文档 notes.md 内容：\n${hugeDoc}`,
    ].join("\n\n")
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
      getChatWindow: () => null,
    }

    await onAgentRunFinished({ reply: "总结好了", toolResults: [] }, latestUserText, deps)

    expect(scheduleMemoryWrite).toHaveBeenCalledWith("帮我总结这个 md", "总结好了")
    expect(matchSticker).toHaveBeenCalledWith(
      "总结好了\n帮我总结这个 md",
      expect.anything(),
      latestIndex,
      0.55,
    )
  })
})
