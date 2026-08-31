import { describe, expect, it } from "vitest";
import { resolveRunCapabilities } from "./run-capabilities";

const tool = (id: string, modes?: Array<"chat" | "work" | "learn" | "code">) => ({ id, modes, enabled: true });
const skill = (id: string, modes?: Array<"work" | "learn" | "code">) => ({ id, modes, enabled: true });

describe("resolveRunCapabilities", () => {
  const tools = [tool("read_file"), tool("git_commit", ["code"]), tool("web_search"), tool("weather")];
  const skills = [skill("office", ["work"]), skill("code-review", ["code"]), skill("study", ["learn"])];
  const input = (mode: "chat" | "work" | "learn" | "code") => ({
    mode,
    activeSearchBackend: "off" as const,
    toolRegistry: { getEnabledToolsForMode: (target: typeof mode) => tools.filter((item) => !item.modes || item.modes.includes(target)) as any },
    skillRegistry: { getEnabledForMode: (target: "work" | "learn" | "code") => skills.filter((item) => !item.modes || item.modes.includes(target)) as any },
  });

  it("makes chat capability-free when enhancement off", () => {
    const result = resolveRunCapabilities(input("chat"));
    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  it("keeps chat tool-free when chatToolsEnabled but nothing opted in", () => {
    // 总开关开启但无任何 chat override 勾选：仍然空——chat 严格 opt-in，
    // 未声明 modes 的工具（read_file）不得漏进闲聊。
    const result = resolveRunCapabilities({ ...input("chat"), chatToolsEnabled: true });
    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  it("exposes only explicitly opted-in tools for enhanced chat", () => {
    // 勾选 weather（未声明 modes）→ 放行；read_file 未勾选 → 拦截；
    // web_search 虽是搜索工具但后端 off 时被互斥过滤（与本测试无关）；
    // skill 恒不暴露。
    const result = resolveRunCapabilities({
      ...input("chat"),
      chatToolsEnabled: true,
      toolModeOverrides: { weather: { chat: true }, read_file: { chat: false } },
    });
    expect([...result.toolIds]).toEqual(["weather"]);
    expect(result.skills).toEqual([]);
  });

  it("honors mode filtering for tools and skills", () => {
    expect(resolveRunCapabilities(input("work")).toolIds).not.toContain("git_commit");
    expect(resolveRunCapabilities(input("code")).toolIds).toContain("git_commit");
    expect(resolveRunCapabilities(input("learn")).skillIds).toEqual(new Set(["study"]));
  });
});
