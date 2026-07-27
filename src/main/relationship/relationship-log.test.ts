import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it } from "vitest"

describe("relationship log", () => {
  let filePath: string

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relationship-log-"))
    filePath = path.join(dir, "relationship-log.json")
  })

  it("records relationship cues without asking for confirmation", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "記憶確認卡片不要，太影響觀感了！",
      assistantText: "明白，這個不做。",
      cyreneFeeling: "溫柔",
      channel: "desktop",
    })

    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      entries: Array<{ userMood: string; relationshipSignal: string; nextCareCue: string }>
      dailySummaries: Array<{ summary: string }>
    }

    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].userMood).toBe("明確邊界")
    expect(data.entries[0].relationshipSignal).toContain("低打擾")
    expect(data.entries[0].nextCareCue).toContain("不要彈確認")
    expect(data.dailySummaries[0].summary).toContain("明確邊界")
  })

  it("builds a compact context from recent cues", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "我今天有點累，先別安排太多",
      assistantText: "那就慢一點來。",
      cyreneFeeling: "擔心",
      channel: "desktop",
    })

    const context = await store.buildContext()

    expect(context).toContain("【近期關係線索】")
    expect(context).toContain("用戶最近狀態")
    expect(context).toContain("疲憊")
    expect(context).toContain("下次回應提示")
  })
})
