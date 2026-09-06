import { describe, expect, it } from "vitest";
import { resolveRunCapabilities } from "./run-capabilities";

const tool = (id: string, modes?: Array<"chat" | "work" | "learn" | "code">, chatBuiltin?: boolean) =>
  ({ id, modes, enabled: true, ...(chatBuiltin ? { chatBuiltin } : {}) });
const skill = (id: string, modes?: Array<"work" | "learn" | "code">) => ({ id, modes, enabled: true });

describe("resolveRunCapabilities", () => {
  const tools = [
    tool("read_file"),
    tool("git_commit", ["code"]),
    tool("web_search"),
    tool("weather"),
    tool("moments_view", ["chat"], true),
    tool("moments_post", ["chat"], true),
  ];
  const skills = [skill("office", ["work"]), skill("code-review", ["code"]), skill("study", ["learn"])];
  // fake registry 镜像真实现：override 优先于 modes 声明
  const filterTools = (mode: string, overrides?: Record<string, any>) =>
    tools.filter((item) => {
      const override = overrides?.[item.id]?.[mode];
      if (override !== undefined) return override;
      return !item.modes || item.modes.includes(mode);
    });
  const input = (mode: "chat" | "work" | "learn" | "code", toolModeOverrides?: Record<string, any>) => ({
    mode,
    activeSearchBackend: "off" as const,
    toolModeOverrides,
    toolRegistry: { getEnabledToolsForMode: (target: typeof mode) => filterTools(target, toolModeOverrides) as any },
    skillRegistry: { getEnabledForMode: (target: "work" | "learn" | "code") => skills.filter((item) => !item.modes || item.modes.includes(target)) as any },
  });

  it("makes chat capability-free when enhancement off (builtins excepted)", () => {
    // 总开关关闭时只剩内置人格工具，其余能力全空
    const result = resolveRunCapabilities(input("chat"));
    expect([...result.toolIds]).toEqual(["moments_view", "moments_post"]);
    expect(result.skills).toEqual([]);
  });

  it("keeps chat tool-free when chatToolsEnabled but nothing opted in", () => {
    // 总开关开启但无任何 chat override 勾选：除内置人格工具外仍然空——
    // chat 严格 opt-in，未声明 modes 的工具（read_file）不得漏进闲聊。
    const result = resolveRunCapabilities({ ...input("chat"), chatToolsEnabled: true });
    expect([...result.toolIds]).toEqual(["moments_view", "moments_post"]);
    expect(result.skills).toEqual([]);
  });

  it("exposes only explicitly opted-in tools for enhanced chat", () => {
    // 勾选 weather（未声明 modes）→ 放行；read_file 未勾选 → 拦截；
    // web_search 虽是搜索工具但后端 off 时被互斥过滤（与本测试无关）；
    // skill 恒不暴露。
    const result = resolveRunCapabilities({
      ...input("chat", { weather: { chat: true }, read_file: { chat: false } }),
      chatToolsEnabled: true,
    });
    // 内置人格工具不依赖 opt-in，排在显式勾选的工具前面；不重复
    expect([...result.toolIds]).toEqual(["moments_view", "moments_post", "weather"]);
    expect(result.skills).toEqual([]);
  });

  it("chat 内置人格工具：总开关关闭也可见，显式勾掉即隐藏", () => {
    // 总开关关闭：chatBuiltin 工具仍放行（人格能力不依赖工具增强开关）
    const off = resolveRunCapabilities(input("chat"));
    expect([...off.toolIds]).toEqual(["moments_view", "moments_post"]);

    // 用户显式 override.chat=false：逃生门仍然有效
    const banned = resolveRunCapabilities(input("chat", { moments_post: { chat: false } }));
    expect([...banned.toolIds]).toEqual(["moments_view"]);

    // chatBuiltin 工具被 opt-in 显式勾选时不重复出现
    const dup = resolveRunCapabilities({
      ...input("chat", { moments_view: { chat: true }, weather: { chat: true } }),
      chatToolsEnabled: true,
    });
    expect(dup.tools.filter((t) => t.id === "moments_view")).toHaveLength(1);
    expect([...dup.toolIds]).toEqual(["moments_view", "moments_post", "weather"]);
  });

  it("honors mode filtering for tools and skills", () => {
    expect(resolveRunCapabilities(input("work")).toolIds).not.toContain("git_commit");
    expect(resolveRunCapabilities(input("code")).toolIds).toContain("git_commit");
    expect(resolveRunCapabilities(input("learn")).skillIds).toEqual(new Set(["study"]));
    // chat 内置工具只声明 chat 模式，不漏进其他模式
    expect(resolveRunCapabilities(input("work")).toolIds).not.toContain("moments_view");
  });
});
