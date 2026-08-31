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
      userText: "记忆确认卡片不要，太影响观感了！",
      assistantText: "明白，这个不做。",
      cyreneFeeling: "温柔",
      channel: "desktop",
    })

    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      entries: Array<{ userMood: string; relationshipSignal: string; nextCareCue: string }>
      dailySummaries: Array<{ summary: string }>
    }

    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].userMood).toBe("明确边界")
    expect(data.entries[0].relationshipSignal).toContain("低打扰")
    expect(data.entries[0].nextCareCue).toContain("不要弹确认")
    expect(data.dailySummaries[0].summary).toContain("明确边界")
  })

  it("builds a compact context from recent cues", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "我今天有点累，先别安排太多",
      assistantText: "那就慢一点来。",
      cyreneFeeling: "担心",
      channel: "desktop",
    })

    const context = await store.buildContext()

    expect(context).toContain("【近期关系线索】")
    expect(context).toContain("用户最近状态")
    expect(context).toContain("疲惫")
    expect(context).toContain("下次回应提示")
  })
})
