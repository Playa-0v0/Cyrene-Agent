import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

function writeFile(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content, "utf8")
}

function readFile(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf8")
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFiles(full).map((f) => path.join(entry.name, f)))
    } else if (entry.name.endsWith(".md") || entry.name === ".cyrene-export-manifest.json") {
      out.push(entry.name)
    }
  }
  return out
}

describe("exportMemoryToObsidianVault", () => {
  let outputDir: string

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-export-"))
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"))
    vi.resetModules()
  })

  it("exports L2/L0/L1 with correct frontmatter and content", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    await memoryStore.updateL0({
      preferredName: "测试用户",
      occupation: "工程师",
      longTermInterests: "画画",
      language: "中文",
      permanentNote: "养了一只猫",
    })
    await memoryStore.updateL1({
      recentGoals: "学钢琴",
      recentPreferences: "偏好深色主题",
      currentProject: "Cyrene",
    })
    const l2 = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "conv_1",
      ragId: "rag_1",
      isPinned: false,
    })

    const result = await exportMemoryToObsidianVault(outputDir)

    expect(result.ok).toBe(true)
    expect(result.fileCount).toBeGreaterThan(0)

    // L0
    const l0md = readFile(outputDir, "画像.md")
    expect(l0md).toContain("preferredName: 测试用户")
    expect(l0md).toContain("occupation: 工程师")
    expect(l0md).toContain("# 用户画像")
    expect(l0md).toContain("画画")

    // L1
    const l1md = readFile(outputDir, "近况.md")
    expect(l1md).toContain("type: 近况")
    expect(l1md).toContain("学钢琴")
    expect(l1md).toContain("Cyrene")

    // L2
    const l2File = path.join(outputDir, "记忆", `${l2.id}.md`)
    expect(fs.existsSync(l2File)).toBe(true)
    const l2md = fs.readFileSync(l2File, "utf8")
    expect(l2md).toContain("id: " + l2.id)
    expect(l2md).toContain("type: 片段")
    expect(l2md).toContain("status: 活跃")
    expect(l2md).toContain("sourceConversationId: conv_1")
    expect(l2md).toContain("ragId: rag_1")
    expect(l2md).toContain("用户喜欢跑步")
    expect(l2md).toContain("tags: [记忆, 片段, active]")
  })

  it("generates [[wikilinks]] for L2 -> L2 relations (subEntryIds, conflictWith, supersededBy)", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    // 两条原始记忆
    const old1 = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "conv",
      ragId: "rag_old1",
      isPinned: false,
    })
    const old2 = await memoryStore.addL2Memory({
      content: "用户每周跑三次",
      triggerText: "每周跑三次",
      sourceConversationId: "conv",
      ragId: "rag_old2",
      isPinned: false,
    })
    // 一条总结，subEntryIds 指向前两条
    const summary = await memoryStore.addL2Memory({
      content: "用户有规律跑步的习惯",
      triggerText: "跑步习惯总结",
      sourceConversationId: "conv",
      ragId: "rag_summary",
      isPinned: false,
    })
    // 手动塞 subEntryIds（addL2Memory 不直接支持）
    const store = await memoryStore.load()
    const summaryEntry = store.l2.find((m) => m.id === summary.id)!
    summaryEntry.subEntryIds = [old1.id, old2.id]
    summaryEntry.isSummary = true
    // 给 old1 标一个冲突（ragId 是 rag_old2）
    const old1Entry = store.l2.find((m) => m.id === old1.id)!
    old1Entry.conflictWith = ["rag_old2"]
    // old2 被 summary 替代
    old1Entry.supersededBy = summary.id
    await memoryStore.save(store)

    await exportMemoryToObsidianVault(outputDir)

    const summaryMd = readFile(path.join(outputDir, "记忆"), `${summary.id}.md`)
    // 总结应该有指向两条原始的 [[双链]]
    expect(summaryMd).toContain(`[[${old1.id}]]`)
    expect(summaryMd).toContain(`[[${old2.id}]]`)
    expect(summaryMd).toContain("压缩自：")
    expect(summaryMd).toContain("isSummary: true")

    const old1Md = readFile(path.join(outputDir, "记忆"), `${old1.id}.md`)
    // old1 冲突指向 old2（rag_old2 反查到 old2.id）
    expect(old1Md).toContain(`[[${old2.id}]]`)
    expect(old1Md).toContain("冲突：")
    // old1 被替代为 summary
    expect(old1Md).toContain(`[[${summary.id}]]`)
    expect(old1Md).toContain("被替代为：")
  })

  it("generates [[wikilinks]] for L2 <-> entity relations (bidirectional)", async () => {
    // 写一个 entity-graph.json，含一个实体
    const entityGraphData = {
      entities: [
        {
          id: "ent_1",
          name: "张三",
          type: "person",
          aliases: ["老张"],
          mentionCount: 2,
          firstMentionedAt: 1000,
          lastMentionedAt: 2000,
        },
      ],
      relations: [],
    }
    writeFile(electronMock.userDataDir, "entity-graph.json", JSON.stringify(entityGraphData, null, 2))

    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    // 一条 L2 content 里提到"张三"
    const l2 = await memoryStore.addL2Memory({
      content: "用户和张三一起去爬山",
      triggerText: "和张三爬山",
      sourceConversationId: "conv",
      ragId: "rag_1",
      isPinned: false,
    })

    await exportMemoryToObsidianVault(outputDir)

    // L2 文件应该有 [[张三]] 链接
    const l2md = readFile(path.join(outputDir, "记忆"), `${l2.id}.md`)
    expect(l2md).toContain("[[张三]]")
    expect(l2md).toContain("提及实体：")

    // 实体文件应该有反向 [[L2 id]] 链接
    const entityMd = readFile(path.join(outputDir, "实体"), "张三.md")
    expect(entityMd).toContain("name: 张三")
    expect(entityMd).toContain("type: 人物")
    expect(entityMd).toContain(`[[${l2.id}]]`)
    expect(entityMd).toContain("出现于")
  })

  it("uses slug as filename and wikilink anchor when L2 has slug, falls back to id otherwise", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    // old：无 slug，回退到 id
    const old = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "conv",
      ragId: "rag_old",
      isPinned: false,
    })
    // summary：有 slug
    const summary = await memoryStore.addL2Memory({
      content: "用户有规律跑步的习惯",
      triggerText: "跑步习惯总结",
      sourceConversationId: "conv",
      ragId: "rag_summary",
      isPinned: false,
    })
    // 手动塞 slug + subEntryIds（addL2Memory 接口接受 slug）
    const store = await memoryStore.load()
    const summaryEntry = store.l2.find((m) => m.id === summary.id)!
    summaryEntry.slug = "规律跑步习惯"
    summaryEntry.subEntryIds = [old.id]
    summaryEntry.isSummary = true
    await memoryStore.save(store)

    await exportMemoryToObsidianVault(outputDir)

    // 1. summary 文件名应该是 slug.md，不是 id.md
    const summarySlugFile = path.join(outputDir, "记忆", "规律跑步习惯.md")
    const summaryIdFile = path.join(outputDir, "记忆", `${summary.id}.md`)
    expect(fs.existsSync(summarySlugFile)).toBe(true)
    expect(fs.existsSync(summaryIdFile)).toBe(false)

    // 2. summary frontmatter 同时含 id 和 slug
    const summaryMd = fs.readFileSync(summarySlugFile, "utf8")
    expect(summaryMd).toContain(`id: ${summary.id}`)
    expect(summaryMd).toContain(`slug: 规律跑步习惯`)
    // 3. summary 无 sourceQuote 时不应输出该字段
    expect(summaryMd).not.toMatch(/^sourceQuote:/m)

    // 4. summary 内的 [[双链]] 指向 old 的 id（old 无 slug，回退到 id）
    expect(summaryMd).toContain(`[[${old.id}]]`)
    expect(summaryMd).toContain("压缩自：")

    // 5. old 文件名仍是 id.md（无 slug 回退）
    const oldIdFile = path.join(outputDir, "记忆", `${old.id}.md`)
    expect(fs.existsSync(oldIdFile)).toBe(true)
    const oldMd = fs.readFileSync(oldIdFile, "utf8")
    // old 的 frontmatter 不应该有 slug 行
    expect(oldMd).not.toMatch(/^slug:/m)
  })

  it("deduplicates conflicting slugs with -2/-3 suffix and keeps original slug in frontmatter", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    // 三条 L2，LLM 给了相同 slug（用户多次说"喜欢香菇"）
    const l2a = await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "conv",
      ragId: "rag_a",
      isPinned: false,
    })
    const l2b = await memoryStore.addL2Memory({
      content: "用户又强调喜欢香菇",
      triggerText: "我真的很喜欢香菇",
      sourceConversationId: "conv",
      ragId: "rag_b",
      isPinned: false,
    })
    const l2c = await memoryStore.addL2Memory({
      content: "用户再次提到喜欢香菇",
      triggerText: "再说一次喜欢香菇",
      sourceConversationId: "conv",
      ragId: "rag_c",
      isPinned: false,
    })

    // 手动塞相同 slug
    const store = await memoryStore.load()
    store.l2.find((m) => m.id === l2a.id)!.slug = "喜欢香菇"
    store.l2.find((m) => m.id === l2b.id)!.slug = "喜欢香菇"
    store.l2.find((m) => m.id === l2c.id)!.slug = "喜欢香菇"
    // 让 c 压缩自 a 和 b（验证跨 L2 wikilink 也用去重后的名字）
    store.l2.find((m) => m.id === l2c.id)!.subEntryIds = [l2a.id, l2b.id]
    await memoryStore.save(store)

    await exportMemoryToObsidianVault(outputDir)

    // 1. 三个文件名应该各不相同：喜欢香菇.md / 喜欢香菇-2.md / 喜欢香菇-3.md
    const fileA = path.join(outputDir, "记忆", "喜欢香菇.md")
    const fileB = path.join(outputDir, "记忆", "喜欢香菇-2.md")
    const fileC = path.join(outputDir, "记忆", "喜欢香菇-3.md")
    expect(fs.existsSync(fileA)).toBe(true)
    expect(fs.existsSync(fileB)).toBe(true)
    expect(fs.existsSync(fileC)).toBe(true)

    // 2. frontmatter 仍存原始 slug（用户可见标题）
    const mdA = fs.readFileSync(fileA, "utf8")
    const mdB = fs.readFileSync(fileB, "utf8")
    const mdC = fs.readFileSync(fileC, "utf8")
    expect(mdA).toContain(`slug: 喜欢香菇`)
    expect(mdB).toContain(`slug: 喜欢香菇`)
    expect(mdC).toContain(`slug: 喜欢香菇`)

    // 3. c 压缩自 a 和 b：wikilink 应指向去重后的 link name，不是原始 slug
    //    避免歧义 [[喜欢香菇]] 同时指向 a/b/c
    expect(mdC).toContain(`[[喜欢香菇]]`)        // a 的去重后 link name
    expect(mdC).toContain(`[[喜欢香菇-2]]`)      // b 的去重后 link name
    expect(mdC).not.toMatch(/\[\[喜欢香菇\]\].*\[\[喜欢香菇\]\]/) // 不应该有两个 [[喜欢香菇]]
  })

  it("writes sourceQuote to L2 frontmatter when present", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    const l2 = await memoryStore.addL2Memory({
      content: "用户用 React 18.2 做前端",
      triggerText: "我用 React 18.2 做的前端",
      sourceConversationId: "conv",
      ragId: "rag_1",
      isPinned: false,
    })
    // 手动塞 slug + sourceQuote（addL2Memory 接口接受这两个字段）
    const store = await memoryStore.load()
    const entry = store.l2.find((m) => m.id === l2.id)!
    entry.slug = "React前端"
    entry.sourceQuote = "我用 React 18.2 做的前端，部署在 vercel 上"
    await memoryStore.save(store)

    await exportMemoryToObsidianVault(outputDir)

    const l2File = path.join(outputDir, "记忆", "React前端.md")
    expect(fs.existsSync(l2File)).toBe(true)
    const l2md = fs.readFileSync(l2File, "utf8")
    expect(l2md).toContain(`id: ${l2.id}`)
    expect(l2md).toContain(`slug: React前端`)
    // sourceQuote 含特殊字符（逗号、点）应被 yamlString 正确转义
    expect(l2md).toContain(`sourceQuote: 我用 React 18.2 做的前端，部署在 vercel 上`)
  })

  it("writes manifest and is idempotent on re-export", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    await memoryStore.addL2Memory({
      content: "记忆 A",
      triggerText: "A",
      sourceConversationId: "conv",
      ragId: "rag_a",
      isPinned: false,
    })

    const r1 = await exportMemoryToObsidianVault(outputDir)
    expect(r1.ok).toBe(true)
    const filesAfter1 = listFiles(outputDir)

    // 二次导出（不增删数据）
    const r2 = await exportMemoryToObsidianVault(outputDir)
    expect(r2.ok).toBe(true)
    const filesAfter2 = listFiles(outputDir)

    // 文件列表应一致（幂等）
    expect(filesAfter2.sort()).toEqual(filesAfter1.sort())
    expect(r2.fileCount).toBe(r1.fileCount)
  })

  it("removes stale files from previous export", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    const l2a = await memoryStore.addL2Memory({
      content: "记忆 A",
      triggerText: "A",
      sourceConversationId: "conv",
      ragId: "rag_a",
      isPinned: false,
    })
    await exportMemoryToObsidianVault(outputDir)
    const l2aFile = path.join(outputDir, "记忆", `${l2a.id}.md`)
    expect(fs.existsSync(l2aFile)).toBe(true)

    // 删掉这条 L2，再导出
    await memoryStore.deleteL2(l2a.id)
    await exportMemoryToObsidianVault(outputDir)

    // 旧文件应该被 manifest 清理掉
    expect(fs.existsSync(l2aFile)).toBe(false)
  })

  it("does not touch user-added md files", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")

    // 用户预先在 vault 里放了一个自己的笔记
    const userNote = path.join(outputDir, "我的笔记.md")
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(userNote, "# 我自己写的\n\n别删我", "utf8")

    await memoryStore.addL2Memory({
      content: "记忆 A",
      triggerText: "A",
      sourceConversationId: "conv",
      ragId: "rag_a",
      isPinned: false,
    })
    await exportMemoryToObsidianVault(outputDir)
    await exportMemoryToObsidianVault(outputDir) // 再导一次

    expect(fs.existsSync(userNote)).toBe(true)
    expect(fs.readFileSync(userNote, "utf8")).toContain("别删我")
  })
})
