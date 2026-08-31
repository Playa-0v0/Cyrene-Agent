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

describe("parseL2Markdown", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-import-"))
    vi.resetModules()
  })

  it("extracts id from frontmatter and content body (with 关联 section)", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      "id: l2_abc_123",
      "type: 片段",
      "status: 活跃",
      "weight: 50",
      "tags: [记忆, 片段, active]",
      "---",
      "",
      "# 用户喜欢跑步",
      "",
      "用户喜欢跑步，每周三次",
      "",
      "## 关联",
      "",
      "- 提及实体：[[张三]]",
      "",
    ].join("\n")

    const { id, content } = parseL2Markdown(md)
    expect(id).toBe("l2_abc_123")
    expect(content).toBe("用户喜欢跑步，每周三次")
  })

  it("extracts content when there is no 关联 section (content to EOF)", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      'id: "l2_quoted"',
      "type: 片段",
      "---",
      "",
      "# 标题",
      "",
      "第一行",
      "第二行",
    ].join("\n")

    const { id, content } = parseL2Markdown(md)
    // 引号包裹的 id 应被去掉引号
    expect(id).toBe("l2_quoted")
    expect(content).toBe("第一行\n第二行")
  })

  it("preserves in-content lines that look like (but aren't) 关联", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      "id: l2_x",
      "---",
      "",
      "# t",
      "",
      "内容包含 ## 其他小节",
      "但不应被截断",
      "",
      "## 关联",
      "",
      "- 链接",
    ].join("\n")
    const { content } = parseL2Markdown(md)
    expect(content).toBe("内容包含 ## 其他小节\n但不应被截断")
  })

  it("returns null content when there is no frontmatter", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = "# 标题\n\n没有 frontmatter"
    const { id, content } = parseL2Markdown(md)
    expect(id).toBeNull()
    expect(content).toBeNull()
  })

  it("returns null content when frontmatter has no id", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = ["---", "type: 片段", "---", "", "# t", "", "正文"].join("\n")
    const { id, content } = parseL2Markdown(md)
    expect(id).toBeNull()
    expect(content).toBeNull()
  })
})

describe("importL2File / importL2Markdown (round-trip)", () => {
  let userDataDir: string
  let vaultDir: string

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-import-"))
    electronMock.userDataDir = userDataDir
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"))
    vi.resetModules()
  })

  it("exports then re-imports an edited vault md, updating PMRS content", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")
    const { importL2File } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "conv_1",
      ragId: "rag_1",
      isPinned: false,
    })

    await exportMemoryToObsidianVault(vaultDir)
    const mdPath = path.join(vaultDir, "记忆", `${l2.id}.md`)
    expect(fs.existsSync(mdPath)).toBe(true)

    // 用户在 Obsidian 里把正文改成了新内容（保留 frontmatter id + 标题结构）
    const editedMd = [
      "---",
      `id: ${l2.id}`,
      "type: 片段",
      "status: 活跃",
      "---",
      "",
      "# 用户喜欢跑步",
      "",
      "用户改成了每周游泳三次",
      "",
    ].join("\n")
    fs.writeFileSync(mdPath, editedMd, "utf8")

    const result = await importL2File(mdPath)
    expect(result.id).toBe(l2.id)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)

    const all = await memoryStore.getAllL2()
    const updated = all.find((m) => m.id === l2.id)!
    expect(updated.content).toBe("用户改成了每周游泳三次")
  })

  it("does not write when vault content is unchanged (changed=false)", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")
    const { importL2File } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "原始内容",
      triggerText: "t",
      sourceConversationId: "c",
      isPinned: false,
    })
    await exportMemoryToObsidianVault(vaultDir)
    const mdPath = path.join(vaultDir, "记忆", `${l2.id}.md`)

    // 直接对未改动的文件调用回流
    const result = await importL2File(mdPath)
    expect(result.changed).toBe(false)
    expect(result.ok).toBe(true)

    const all = await memoryStore.getAllL2()
    expect(all.find((m) => m.id === l2.id)!.content).toBe("原始内容")
  })

  it("returns not-found for an unknown id", async () => {
    const { importL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      "id: l2_does_not_exist",
      "---",
      "",
      "# t",
      "",
      "正文",
      "",
    ].join("\n")
    const result = await importL2Markdown(md)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("not-found")
    expect(result.changed).toBe(false)
  })

  it("updateL2Content only touches content, not status/weight/createdAt", async () => {
    const { memoryStore } = await import("./memory-store")
    const l2 = await memoryStore.addL2Memory({
      content: "原始",
      triggerText: "t",
      sourceConversationId: "c",
      isPinned: false,
    })
    const before = (await memoryStore.getAllL2()).find((m) => m.id === l2.id)!
    await memoryStore.updateL2Content(l2.id, "新内容")
    const after = (await memoryStore.getAllL2()).find((m) => m.id === l2.id)!

    expect(after.content).toBe("新内容")
    // 运行时字段应保持不变
    expect(after.status).toBe(before.status)
    expect(after.weight).toBe(before.weight)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.accessCount).toBe(before.accessCount)
    expect(after.ragId).toBe(before.ragId)
  })
})
