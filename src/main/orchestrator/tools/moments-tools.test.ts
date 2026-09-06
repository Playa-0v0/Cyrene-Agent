// 朋友圈聊天工具单测：参数校验、闸门文案与三件套注册形态。
// momentsService 与设置门面全部 mock——这里只测工具层的包装与提示逻辑，
// 落库链路在 moments-service.test.ts 的工具通道用例里覆盖。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MomentFeedItem } from "../../../shared/moments-types";
import type { ToolDefinition } from "./registry/tool-registry";

const mocks = vi.hoisted(() => ({
  loadGeneralSettings: vi.fn(),
  listFeed: vi.fn(),
  cyreneCreatePostFromTool: vi.fn(),
  cyreneLikeFromTool: vi.fn(),
  cyreneCommentFromTool: vi.fn(),
}));

vi.mock("../../settings/settings-facade", () => ({ loadGeneralSettings: mocks.loadGeneralSettings }));
vi.mock("../../moments/moments-service", () => ({
  momentsService: {
    listFeed: mocks.listFeed,
    cyreneCreatePostFromTool: mocks.cyreneCreatePostFromTool,
    cyreneLikeFromTool: mocks.cyreneLikeFromTool,
    cyreneCommentFromTool: mocks.cyreneCommentFromTool,
  },
}));

// 内存注册表：绕开真注册表的重依赖（rag → electron 链），只验注册形态与执行
vi.mock("./registry/tool-registry", () => {
  const tools = new Map<string, ToolDefinition>();
  return {
    toolRegistry: {
      register: (tool: ToolDefinition) => tools.set(tool.id, tool),
      unregister: (id: string) => tools.delete(id),
      getAllTools: () => [...tools.values()],
    },
  };
});

import { registerMomentsTools } from "./moments-tools";
import { toolRegistry } from "./registry/tool-registry";

function getTool(id: string): ToolDefinition {
  const tool = toolRegistry.getAllTools().find((t) => t.id === id);
  if (!tool) throw new Error(`工具未注册: ${id}`);
  return tool;
}

function makeFeedItem(overrides: Partial<MomentFeedItem> = {}): MomentFeedItem {
  return {
    post: { id: "moment_p1", author: "user", text: "用户动态正文", media: [], createdAt: Date.now() - 5 * 60_000 },
    comments: [],
    likes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registerMomentsTools();
  mocks.loadGeneralSettings.mockReturnValue({ momentsEnabled: true });
});

describe("moments 工具注册形态", () => {
  it("三件套均注册为 chat 内置人格工具", () => {
    for (const id of ["moments_view", "moments_post", "moments_interact"]) {
      const tool = getTool(id);
      expect(tool.modes).toEqual(["chat"]);
      expect(tool.chatBuiltin).toBe(true);
      expect(tool.enabled).toBe(true);
    }
  });
});

describe("moments_view 看朋友圈", () => {
  it("朋友圈关闭时返回可读提示，不查数据", async () => {
    mocks.loadGeneralSettings.mockReturnValue({ momentsEnabled: false });
    const output = await getTool("moments_view").execute({});
    expect(output).toContain("关闭");
    expect(mocks.listFeed).not.toHaveBeenCalled();
  });

  it("空朋友圈提示看不到任何东西", async () => {
    mocks.listFeed.mockReturnValue([]);
    const output = await getTool("moments_view").execute({});
    expect(output).toContain("空的");
  });

  it("正常输出：作者、相对时间、内容与互动摘要，limit 收敛到 1~30", async () => {
    mocks.listFeed.mockReturnValue([
      makeFeedItem(),
      makeFeedItem({
        post: { id: "moment_cy1", author: "cyrene", text: "a".repeat(100), media: [{ id: "m1", type: "image", origin: "character_asset", ref: "x.png" }], createdAt: Date.now() - 2 * 60 * 60_000 },
        comments: [{ id: "comment_c1", postId: "moment_cy1", author: "万敌", content: "路过", createdAt: Date.now() }],
        likes: [{ postId: "moment_cy1", actor: "万敌", type: "like", createdAt: Date.now() }],
      }),
    ]);

    const output = await getTool("moments_view").execute({ limit: 999 });
    expect(mocks.listFeed).toHaveBeenCalledWith({ limit: 30 });
    expect(output).toContain("moment_p1");
    expect(output).toContain("主人");
    expect(output).toContain("5 分钟前");
    expect(output).toContain("moment_cy1");
    expect(output).toContain("我"); // 昔涟视角的作者标签
    expect(output).toContain("2 小时前");
    expect(output).toContain("…"); // 长文截断
    expect(output).toContain("1 张图");
    expect(output).toContain("万敌：路过");
    expect(output).toContain("1 个赞");
  });
});

describe("moments_post 发朋友圈", () => {
  it("text 缺失时报错并回传实际收到的参数键", async () => {
    const output = await getTool("moments_post").execute({ title: "只有标题" });
    expect(output).toContain("[错误]");
    expect(output).toContain("title");
  });

  it("发帖成功返回 postId", async () => {
    mocks.cyreneCreatePostFromTool.mockResolvedValue({ applied: true, value: { id: "moment_cy1" } });
    const output = await getTool("moments_post").execute({ text: "今天天气真好" });
    expect(mocks.cyreneCreatePostFromTool).toHaveBeenCalledWith({ title: undefined, text: "今天天气真好" });
    expect(output).toContain("moment_cy1");
  });

  it("开关关闭时返回可读原因（昔涟据此向用户解释）", async () => {
    mocks.cyreneCreatePostFromTool.mockResolvedValue({ applied: false, reason: "moments_disabled" });
    const output = await getTool("moments_post").execute({ text: "发不出去" });
    expect(output).toContain("开关");
    expect(output).not.toContain("[错误]");
  });
});

describe("moments_interact 朋友圈互动", () => {
  it("postId 缺失时报错并回传实际收到的参数键", async () => {
    const output = await getTool("moments_interact").execute({ action: "like" });
    expect(output).toContain("[错误]");
    expect(output).toContain("action");
  });

  it("action 非法时报错并回传收到的值", async () => {
    const output = await getTool("moments_interact").execute({ postId: "p1", action: "share" });
    expect(output).toContain("like 或 comment");
    expect(output).toContain("share");
  });

  it("点赞成功", async () => {
    mocks.cyreneLikeFromTool.mockResolvedValue({ applied: true, value: { liked: true } });
    const output = await getTool("moments_interact").execute({ postId: "p1", action: "like" });
    expect(mocks.cyreneLikeFromTool).toHaveBeenCalledWith("p1");
    expect(output).toContain("已点赞");
  });

  it("已点过赞返回自然提示而非报错", async () => {
    mocks.cyreneLikeFromTool.mockResolvedValue({ applied: false, reason: "reaction_exists" });
    const output = await getTool("moments_interact").execute({ postId: "p1", action: "like" });
    expect(output).toContain("已经点过赞");
  });

  it("目标动态不存在时引导先看动态", async () => {
    mocks.cyreneLikeFromTool.mockResolvedValue({ applied: false, reason: "post_not_found" });
    const output = await getTool("moments_interact").execute({ postId: "p404", action: "like" });
    expect(output).toContain("moments_view");
  });

  it("评论缺 content 报错；成功返回评论 id 并透传 replyTo", async () => {
    const missing = await getTool("moments_interact").execute({ postId: "p1", action: "comment" });
    expect(missing).toContain("[错误]");

    mocks.cyreneCommentFromTool.mockResolvedValue({
      applied: true,
      value: { id: "comment_c9", postId: "p1", author: "cyrene", content: "好耶", createdAt: 1 },
    });
    const output = await getTool("moments_interact").execute({
      postId: "p1",
      action: "comment",
      content: "好耶",
      replyTo: "comment_c1",
    });
    expect(mocks.cyreneCommentFromTool).toHaveBeenCalledWith({ postId: "p1", content: "好耶", replyTo: "comment_c1" });
    expect(output).toContain("comment_c9");
  });
});
