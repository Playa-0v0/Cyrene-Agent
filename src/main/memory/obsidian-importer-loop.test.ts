// 独立文件：验证 isImporting 标志在回流期间跳过 PMRS→Obsidian 反向同步，避免双向循环。
//
// 单独成文件的原因：在 obsidian-importer.test.ts 里与多个 describe 共用 vi.resetModules()
// 会在累计多次 reset 后偶发返回未初始化的模块命名空间（vitest 已知现象）。此处仅一次
// reset + 单个测试，规避该现象。

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

describe("isImporting flag prevents PMRS→Obsidian sync loop", () => {
  let vaultDir: string

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-loop-"))
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"))
    vi.resetModules()
  })

  afterEach(async () => {
    const { _resetForTest } = await import("./obsidian-importer")
    _resetForTest()
    // 清理临时目录，避免 fs.watch 在 worker 退出时因监听已删除目录而崩溃
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

  it("回流期间的记忆写入不会触发反向同步", async () => {
    const { memoryStore } = await import("./memory-store")
    const { saveObsidianVaultConfig, loadObsidianVaultConfig } = await import("./obsidian-vault-config")
    const { setImportingMemory } = await import("./obsidian-sync-flag")

    // 绑定 + 开启自动同步
    saveObsidianVaultConfig({ vaultPath: vaultDir, autoSync: true })

    // 写一条记忆 → save 触发 notifyMemoryChanged（flag=false）→ 2s 后同步 → lastSyncAt 落地
    const l2 = await memoryStore.addL2Memory({
      content: "原始内容A",
      triggerText: "t",
      sourceConversationId: "c",
      isPinned: false,
    })
    await wait(2300)
    const cfg1 = loadObsidianVaultConfig()
    expect(cfg1.lastSyncAt).toBeGreaterThan(0)
    const lastSync1 = cfg1.lastSyncAt

    // 模拟回流：置 flag=true，改 content → save 同步检查标志跳过 notifyMemoryChanged
    setImportingMemory(true)
    await memoryStore.updateL2Content(l2.id, "回流后的新内容")
    setImportingMemory(false)

    // 等过 debounce 窗口，确认没有发生反向同步（lastSyncAt 不应推进）
    await wait(2300)
    const cfg2 = loadObsidianVaultConfig()
    expect(cfg2.lastSyncAt).toBe(lastSync1)

    // 但 PMRS 里的内容确实被回流改了
    const all = await memoryStore.getAllL2()
    expect(all.find((m) => m.id === l2.id)!.content).toBe("回流后的新内容")
  }, 20000)
})
