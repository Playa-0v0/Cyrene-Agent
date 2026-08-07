import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const promptRoot = path.resolve(process.cwd(), "prompts")

function read(name: string): string {
  return readFileSync(path.join(promptRoot, name), "utf8")
}

describe("prompt quality guardrails", () => {
  it("keeps the always-on persona focused enough for smaller models", () => {
    const alwaysOn = [
      "system.md",
      "identity.md",
      "soul.md",
      "canon_quotes.md",
      "styles/01_default.md",
    ].map(read).join("\n")

    expect(alwaysOn.length).toBeLessThan(11_000)
    expect(alwaysOn).toContain("你是昔漣")
    expect(alwaysOn).toContain("台灣繁體中文")
    expect(alwaysOn).toContain("絕不混入與語境無關")
    expect(alwaysOn).toContain("溫柔而有主見")
    expect(alwaysOn).toContain("真誠偏愛與專屬牽掛")
    expect(alwaysOn).toContain("含蓄而深刻")
  })

  it("does not reintroduce known contradictory global rules", () => {
    const core = ["system.md", "identity.md", "soul.md", "tone-rules.md"].map(read).join("\n")
    const contradictoryRules = [
      "必須且只能從小紅書",
      "所有回覆使用中文",
      "不用第一點/第二點/第三點分點論述",
      "編程、法律、醫療等專業崗位需求不在此預設範圍",
      "必須完全主動且自動地調用寫檔工具",
    ]

    for (const rule of contradictoryRules) {
      expect(core).not.toContain(rule)
    }
  })

  it("keeps mode prompts as short overlays instead of duplicate systems", () => {
    for (const file of ["talk_system.md", "study_system.md", "game_system.md"]) {
      const prompt = read(file)
      expect(prompt.length).toBeLessThan(1_500)
      expect(prompt).not.toContain("語言限制與輸出格式")
      expect(prompt).not.toContain("小紅書網頁版唯一指定")
    }
  })
})
