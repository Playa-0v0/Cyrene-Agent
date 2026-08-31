import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearRecentMemoryInjections, wasRecentlyInjectedMemory } from "../memory/recent-injected-memory"

const ragMock = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  searchMemoryEntries: vi.fn(),
  updateWorldbookActivation: vi.fn(),
  getPermanentWorldbookEntries: vi.fn(),
  getActiveWorldbookEntries: vi.fn(),
  getCascadeWorldbookEntries: vi.fn(),
  INJECTION_HEADER: "HEADER",
  INJECTION_PREAMBLE: "PREAMBLE",
}))

const memoryStoreMock = vi.hoisted(() => ({
  getAllL2: vi.fn(),
  getL0: vi.fn(),
  getL1: vi.fn(),
}))

const entityGraphMock = vi.hoisted(() => ({
  search: vi.fn(),
}))

const l2DmaeManagerMock = vi.hoisted(() => ({
  getActiveL2ForPrompt: vi.fn(),
}))

vi.mock("../rag", () => ragMock)
vi.mock("../memory/memory-store", () => ({ memoryStore: memoryStoreMock }))
vi.mock("../memory/entity-graph", () => ({ entityGraph: entityGraphMock }))
vi.mock("../memory/l2-dmae-manager", () => ({ l2DmaeManager: l2DmaeManagerMock }))
vi.mock("./tool-registry", () => ({ toolRegistry: { getEnabledTools: vi.fn(() => []), getEnabledToolsForMode: vi.fn(() => []) } }))

describe("buildMemoryInjection", () => {
  beforeEach(() => {
    clearRecentMemoryInjections()
    ragMock.searchMemory.mockReset()
    ragMock.searchMemory.mockResolvedValue([])
    memoryStoreMock.getAllL2.mockReset()
    memoryStoreMock.getAllL2.mockResolvedValue([])
    l2DmaeManagerMock.getActiveL2ForPrompt.mockReset()
    l2DmaeManagerMock.getActiveL2ForPrompt.mockResolvedValue([])
    entityGraphMock.search.mockReset()
    entityGraphMock.search.mockReturnValue("")
  })

  it("records injected user memory l2 ids from DMAE active L2", async () => {
    memoryStoreMock.getAllL2.mockResolvedValue([
      { id: "l2_run", content: "用户喜欢跑步", triggerText: "我喜欢跑步" },
    ])
    l2DmaeManagerMock.getActiveL2ForPrompt.mockResolvedValue([
      { id: "l2_run", content: "用户喜欢跑步", triggerText: "我喜欢跑步" },
    ])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("跑步")

    expect(context).toContain("用户喜欢跑步")
    expect(wasRecentlyInjectedMemory("l2_run")).toBe(true)
    expect(l2DmaeManagerMock.getActiveL2ForPrompt).toHaveBeenCalledWith(expect.any(Array), 4)
  })

  it("appends sourceQuote as 原文 suffix when L2 has one, falls back to triggerText otherwise", async () => {
    memoryStoreMock.getAllL2.mockResolvedValue([
      { id: "l2_run", content: "用户喜欢跑步", triggerText: "我喜欢跑步", sourceQuote: "我每周都去跑步，雷打不动" },
      { id: "l2_react", content: "用户用 React 做前端", triggerText: "我用 React 做前端" },
    ])
    l2DmaeManagerMock.getActiveL2ForPrompt.mockResolvedValue([
      { id: "l2_run", content: "用户喜欢跑步", triggerText: "我喜欢跑步", sourceQuote: "我每周都去跑步，雷打不动" },
      { id: "l2_react", content: "用户用 React 做前端", triggerText: "我用 React 做前端" },
    ])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("跑步 React")

    // 有 sourceQuote → 用 sourceQuote 原文
    expect(context).toContain("· 用户喜欢跑步（原文：我每周都去跑步，雷打不动）")
    // 无 sourceQuote → 回退到 triggerText
    expect(context).toContain("· 用户用 React 做前端（原文：我用 React 做前端）")
  })

  it("returns empty when no active L2", async () => {
    memoryStoreMock.getAllL2.mockResolvedValue([
      { id: "l2_run", content: "用户喜欢跑步", triggerText: "我喜欢跑步" },
    ])
    l2DmaeManagerMock.getActiveL2ForPrompt.mockResolvedValue([])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("跑步")

    expect(context).toBe("")
    expect(wasRecentlyInjectedMemory("l2_run")).toBe(false)
  })
})

describe("buildAlwaysOnContext", () => {
  beforeEach(() => {
    ragMock.updateWorldbookActivation.mockReset()
    ragMock.getPermanentWorldbookEntries.mockReset()
    ragMock.getActiveWorldbookEntries.mockReset()
    ragMock.getCascadeWorldbookEntries.mockReset()
    ragMock.getPermanentWorldbookEntries.mockReturnValue([])
    ragMock.getActiveWorldbookEntries.mockReturnValue([])
    ragMock.getCascadeWorldbookEntries.mockReturnValue([])
    memoryStoreMock.getL0.mockReset()
    memoryStoreMock.getL1.mockReset()
    memoryStoreMock.getL0.mockResolvedValue({})
    memoryStoreMock.getL1.mockResolvedValue({})
  })

  it("does not let document modelContext trigger worldbook activation", async () => {
    const { buildAlwaysOnContext } = await import("./index")

    await buildAlwaysOnContext(
      "请总结这个文档\n\n【文档内容】\n文档里写着 迷迷 和 PHILIA093。",
      [],
    )

    expect(ragMock.updateWorldbookActivation).toHaveBeenCalledWith("请总结这个文档", "")
  })
})
