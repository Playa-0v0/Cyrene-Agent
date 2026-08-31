// 独立文件：验证 fs.watch 监听 <vault>/记忆/ 目录，能在用户编辑 md 后回流到 PMRS。
//
// 单独成文件的原因同 obsidian-importer-loop.test.ts：避免与多个 describe 共用
// vi.resetModules() 累计后偶发的模块命名空间未初始化现象。此处仅一次 reset + 单个测试。

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("vault watcher", () => {
  let vaultDir: string

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-watcher-"))
    // 解析为规范长路径，避免 Windows 短路径导致 fs.watch 内部断言失败
    vaultDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")))
    vi.resetModules()
  })

  afterEach(async () => {
    const { _resetForTest } = await import("./obsidian-importer")
    _resetForTest()
    try {
      fs.rmSync(electronMock.userDataDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    try {
      fs.rmSync(vaultDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it("starts watcher, picks up vault edits, and stops cleanly", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")
    const { startVaultWatcher, stopVaultWatcher, isVaultWatcherActive } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "原始内容",
      triggerText: "t",
      sourceConversationId: "c",
      isPinned: false,
    })
    await exportMemoryToObsidianVault(vaultDir)
    const mdPath = path.join(vaultDir, "记忆", `${l2.id}.md`)

    startVaultWatcher(vaultDir)
    try {
      expect(isVaultWatcherActive()).toBe(true)

      // 在 Obsidian 里改写正文（保留 frontmatter id）
      const editedMd = [
        "---",
        `id: ${l2.id}`,
        "type: 片段",
        "---",
        "",
        "# 标题",
        "",
        "通过 watcher 回流的新内容",
        "",
      ].join("\n")
      fs.writeFileSync(mdPath, editedMd, "utf8")

      // 轮询等待 watcher + 2s debounce 处理完毕
      const deadline = Date.now() + 6000
      let ok = false
      while (Date.now() < deadline) {
        const all = await memoryStore.getAllL2()
        const cur = all.find((m) => m.id === l2.id)
        if (cur?.content === "通过 watcher 回流的新内容") {
          ok = true
          break
        }
        await wait(200)
      }
      expect(ok).toBe(true)
    } finally {
      stopVaultWatcher()
    }
    expect(isVaultWatcherActive()).toBe(false)
  }, 20000)
})
