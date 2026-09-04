// moments-agent 契约测试：prompt 构建、决策解析、后台模型调用与决策提交。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOMENT_MAX_COMMENT_TEXT_LENGTH,
  type MomentComment,
  type MomentFeedItem,
  type MomentMedia,
  type MomentPost,
} from "../../shared/moments-types";

const mocks = vi.hoisted(() => ({
  buildRequest: vi.fn(),
  parseResponse: vi.fn(),
  recordUsage: vi.fn(),
  recordRequest: vi.fn(),
}));

vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: mocks.buildRequest,
    parseResponse: mocks.parseResponse,
  }),
}));

vi.mock("../token-usage-store", () => ({ recordUsage: mocks.recordUsage, recordRequest: mocks.recordRequest }));

import {
  MOMENTS_MODEL_MAX_TOKENS,
  buildPostGenerationMessages,
  buildReactionMessages,
  buildReplyMessages,
  createMomentsAgent,
  parsePostDecision,
  parseReactionDecision,
  parseReplyDecision,
  runMomentsModel,
} from "./moments-agent";

const PERSONA = "测试人设";

function makePost(overrides: Partial<MomentPost> = {}): MomentPost {
  return {
    id: "moment_p1",
    author: "user",
    text: "今天天气不错",
    media: [],
    createdAt: new Date("2026-09-04T09:00:00").getTime(),
    ...overrides,
  };
}

function makeComment(overrides: Partial<MomentComment> = {}): MomentComment {
  return {
    id: "comment_c1",
    postId: "moment_p1",
    author: "user",
    content: "一条评论",
    createdAt: new Date("2026-09-04T09:01:00").getTime(),
    ...overrides,
  };
}
describe("parseReactionDecision", () => {
  it("解析点赞 + 评论的组合决策，文本 trim 后生效", () => {
    expect(parseReactionDecision('{"like":true,"comment":{"shouldComment":true,"text":" 好耶 "}}'))
      .toEqual({ kind: "react", like: true, commentText: "好耶" });
  });

  it("只点赞与只评论都是合法组合", () => {
    expect(parseReactionDecision('{"like":true,"comment":{"shouldComment":false}}'))
      .toEqual({ kind: "react", like: true, commentText: null });
    expect(parseReactionDecision('{"like":false,"comment":{"shouldComment":true,"text":"路过"}}'))
      .toEqual({ kind: "react", like: false, commentText: "路过" });
  });

  it("不点赞不评论是 ignore 而非错误", () => {
    expect(parseReactionDecision('{"like":false,"comment":{"shouldComment":false}}')).toEqual({ kind: "ignore" });
    expect(parseReactionDecision('{"like":false}')).toEqual({ kind: "ignore" });
  });

  it("JSON 解析失败与结构非法返回 invalid 并给出原因", () => {
    expect(parseReactionDecision("不是 json")).toEqual({ kind: "invalid", reason: "invalid_json" });
    expect(parseReactionDecision("[]")).toEqual({ kind: "invalid", reason: "invalid_shape" });
    expect(parseReactionDecision('{"like":"yes"}')).toEqual({ kind: "invalid", reason: "invalid_like" });
    expect(parseReactionDecision('{"like":true,"comment":{"shouldComment":"yes"}}'))
      .toEqual({ kind: "invalid", reason: "invalid_should_comment" });
    expect(parseReactionDecision('{"like":true,"comment":[]}')).toEqual({ kind: "invalid", reason: "invalid_comment" });
  });

  it("评论文本为空或超长返回 invalid", () => {
    expect(parseReactionDecision('{"like":true,"comment":{"shouldComment":true,"text":"   "}}'))
      .toEqual({ kind: "invalid", reason: "empty_comment_text" });
    expect(
      parseReactionDecision(
        `{"like":true,"comment":{"shouldComment":true,"text":"${"长".repeat(MOMENT_MAX_COMMENT_TEXT_LENGTH + 1)}"}}`,
      ),
    ).toEqual({ kind: "invalid", reason: "comment_text_too_long" });
  });
});

describe("parseReplyDecision", () => {
  it("解析回复与跳过", () => {
    expect(parseReplyDecision('{"shouldReply":true,"text":" 嗯嗯 "}')).toEqual({ kind: "reply", text: "嗯嗯" });
    expect(parseReplyDecision('{"shouldReply":false,"text":""}')).toEqual({ kind: "skip" });
  });

  it("结构非法返回 invalid 并给出原因", () => {
    expect(parseReplyDecision("oops")).toEqual({ kind: "invalid", reason: "invalid_json" });
    expect(parseReplyDecision('{"shouldReply":"maybe"}')).toEqual({ kind: "invalid", reason: "invalid_should_reply" });
    expect(parseReplyDecision('{"shouldReply":true,"text":"  "}')).toEqual({ kind: "invalid", reason: "empty_text" });
    expect(
      parseReplyDecision(`{"shouldReply":true,"text":"${"长".repeat(MOMENT_MAX_COMMENT_TEXT_LENGTH + 1)}"}`),
    ).toEqual({ kind: "invalid", reason: "text_too_long" });
  });
});
describe("buildReactionMessages", () => {
  it("system 由人设与反应指令拼接，user 携带动态要素与 JSON 约定", () => {
    const messages = buildReactionMessages({
      persona: PERSONA,
      post: { title: " 标题 ", text: "正文内容", imageCount: 2 },
      localNow: new Date("2026-09-04T10:30:00"),
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(PERSONA);
    expect(messages[0].content).toContain("[moments_react_system]");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("标题：标题");
    expect(messages[1].content).toContain("正文：正文内容");
    expect(messages[1].content).toContain("配图：2 张");
    expect(messages[1].content).toContain("2026-09-04 10:30 周五");
    expect(messages[1].content).toContain('"like"');
  });

  it("人设为空时 system 仍包含反应指令", () => {
    const messages = buildReactionMessages({
      persona: "",
      post: { text: "x", imageCount: 0 },
      localNow: new Date("2026-09-04T10:30:00"),
    });
    expect(messages[0].content).toContain("[moments_react_system]");
  });

  it("无标题的动态不输出标题行", () => {
    const messages = buildReactionMessages({
      persona: PERSONA,
      post: { text: "没有标题", imageCount: 0 },
      localNow: new Date("2026-09-04T10:30:00"),
    });
    expect(messages[1].content).not.toContain("标题：");
  });
});

describe("buildReplyMessages", () => {
  function makeFeed(): { post: MomentPost; comments: MomentComment[] } {
    return {
      post: makePost({
        author: "cyrene",
        text: "昔涟发的动态",
        source: { type: "conversation", triggerExcerpt: "之前聊到的约定" },
      }),
      comments: [
        makeComment({ id: "c1", author: "cyrene", content: "昔涟先评论", createdAt: 100 }),
        makeComment({ id: "c2", author: "user", content: "用户回复昔涟", replyTo: "c1", createdAt: 200 }),
        makeComment({ id: "c3", author: "user", content: "无关顶级评论", createdAt: 300 }),
      ],
    };
  }

  it("回复链全量保留并标注回复关系，原始动态与触发摘录都进入上下文", () => {
    const feed = makeFeed();
    const messages = buildReplyMessages({
      persona: PERSONA,
      post: feed.post,
      comments: feed.comments,
      replyTargetId: "c2",
      triggerExcerpt: "之前聊到的约定",
      localNow: new Date("2026-09-04T11:00:00"),
    });

    expect(messages).toHaveLength(2);
    const user = String(messages[1].content);
    expect(user).toContain("[原始动态]");
    expect(user).toContain("昔涟发的动态");
    expect(user).toContain("用户（回复昔涟）：用户回复昔涟");
    expect(user).toContain("之前聊到的约定");
    expect(user).toContain('"shouldReply"');
  });

  it("无触发摘录的动态不输出摘录段", () => {
    const feed = makeFeed();
    const noSource = buildReplyMessages({
      persona: PERSONA,
      post: makePost({ author: "cyrene" }),
      comments: feed.comments,
      replyTargetId: "c2",
      localNow: new Date("2026-09-04T11:00:00"),
    });
    expect(String(noSource[1].content)).not.toContain("[触发摘录]");
  });
});
describe("runMomentsModel", () => {
  const SETTINGS = { provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildRequest.mockImplementation((request: unknown) => ({
      url: "https://example.test/chat",
      headers: { Authorization: "Bearer secret" },
      body: JSON.stringify(request),
    }));
  });

  it("发出非流式、限长、无工具的请求并记录 token 用量", async () => {
    mocks.parseResponse.mockReturnValue({ text: '{"like":true}', usage: { input: 12, output: 8 } });
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));

    const result = await runMomentsModel({
      settings: SETTINGS,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      timeoutMs: 1_000,
      fetchFn,
    });

    const request = mocks.buildRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(request.stream).toBe(false);
    expect(request.maxTokens).toBe(MOMENTS_MODEL_MAX_TOKENS);
    expect(request).not.toHaveProperty("tools");
    expect(result).toEqual({ kind: "text", text: '{"like":true}' });
    expect(mocks.recordUsage).toHaveBeenCalledWith(12, 8, 1, undefined, "model", undefined);
  });

  it("含 tool 内容的消息直接拒绝，不发起网络请求", async () => {
    const fetchFn = vi.fn();
    const result = await runMomentsModel({
      settings: SETTINGS,
      messages: [{ role: "tool", content: "forbidden", toolCallId: "1" }],
      timeoutMs: 1_000,
      fetchFn,
    });
    expect(result).toEqual({ kind: "error", reason: "tool_content_forbidden" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("HTTP 非 2xx 与响应解析失败返回对应错误原因", async () => {
    await expect(runMomentsModel({
      settings: SETTINGS,
      messages: [{ role: "system", content: "system" }],
      timeoutMs: 1_000,
      fetchFn: vi.fn(async () => new Response("bad", { status: 503 })),
    })).resolves.toEqual({ kind: "error", reason: "http_503" });

    mocks.parseResponse.mockImplementation(() => {
      throw new Error("unexpected shape");
    });
    await expect(runMomentsModel({
      settings: SETTINGS,
      messages: [{ role: "system", content: "system" }],
      timeoutMs: 1_000,
      fetchFn: vi.fn(async () => new Response("{}", { status: 200 })),
    })).resolves.toEqual({ kind: "error", reason: "invalid_provider_response" });
  });

  it("超时中断返回 timeout", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    await expect(runMomentsModel({
      settings: SETTINGS,
      messages: [{ role: "system", content: "system" }],
      timeoutMs: 10,
      fetchFn,
    })).resolves.toEqual({ kind: "error", reason: "timeout" });
  });
});
describe("createMomentsAgent", () => {
  function makeHarness(overrides: {
    modelText?: string;
    modelOutput?: { kind: "error"; reason: string };
    feed?: MomentFeedItem | null;
  }) {
    const runModel = vi.fn(
      async () => overrides.modelOutput ?? { kind: "text", text: overrides.modelText ?? "" },
    );
    const commitLike = vi.fn(async () => undefined);
    const commitComment = vi.fn(async () => undefined);
    const commitPost = vi.fn(async () => ({ applied: true }));
    const loadFeedItem = vi.fn(() => overrides.feed ?? null);
    const log = vi.fn();
    const agent = createMomentsAgent({
      buildPersona: () => PERSONA,
      runModel,
      commitLike,
      commitComment,
      commitPost,
      loadFeedItem,
      log,
    });
    return { agent, runModel, commitLike, commitComment, loadFeedItem, log };
  }

  describe("evaluateUserPost", () => {
    it("点赞与评论决策分别提交", async () => {
      const h = makeHarness({ modelText: '{"like":true,"comment":{"shouldComment":true,"text":"写得好"}}' });
      const post = makePost();
      await h.agent.evaluateUserPost(post);

      expect(h.runModel).toHaveBeenCalledTimes(1);
      expect(h.commitLike).toHaveBeenCalledWith("moment_p1");
      expect(h.commitComment).toHaveBeenCalledWith({ postId: "moment_p1", content: "写得好" });
    });

    it("ignore 决策不提交任何东西", async () => {
      const h = makeHarness({ modelText: '{"like":false,"comment":{"shouldComment":false}}' });
      await h.agent.evaluateUserPost(makePost());
      expect(h.commitLike).not.toHaveBeenCalled();
      expect(h.commitComment).not.toHaveBeenCalled();
    });

    it("决策无效时记录日志并静默放弃", async () => {
      const h = makeHarness({ modelText: "乱七八糟" });
      await h.agent.evaluateUserPost(makePost());
      expect(h.log).toHaveBeenCalledWith("reaction_decision_invalid", "invalid_json");
      expect(h.commitLike).not.toHaveBeenCalled();
      expect(h.commitComment).not.toHaveBeenCalled();
    });

    it("模型调用失败时静默放弃", async () => {
      const h = makeHarness({ modelOutput: { kind: "error", reason: "timeout" } });
      await h.agent.evaluateUserPost(makePost());
      expect(h.commitLike).not.toHaveBeenCalled();
      expect(h.commitComment).not.toHaveBeenCalled();
    });
  });

  describe("generateCommentReply", () => {
    function makeFeed(): MomentFeedItem {
      return {
        post: makePost({ author: "cyrene", text: "昔涟动态" }),
        comments: [
          makeComment({ id: "c1", author: "cyrene", content: "昔涟评论", createdAt: 100 }),
          makeComment({ id: "c2", author: "user", content: "用户回复", replyTo: "c1", createdAt: 200 }),
        ],
        likes: [],
      };
    }

    it("动态已被删除时静默放弃", async () => {
      const h = makeHarness({ feed: null, modelText: '{"shouldReply":true,"text":"好"}' });
      await h.agent.generateCommentReply("moment_p1", "c2");
      expect(h.runModel).not.toHaveBeenCalled();
      expect(h.commitComment).not.toHaveBeenCalled();
    });

    it("触发评论已被删除时静默放弃", async () => {
      const h = makeHarness({ feed: makeFeed(), modelText: '{"shouldReply":true,"text":"好"}' });
      await h.agent.generateCommentReply("moment_p1", "c_deleted");
      expect(h.runModel).not.toHaveBeenCalled();
      expect(h.commitComment).not.toHaveBeenCalled();
    });

    it("回复决策成功时携带 replyTo 提交评论", async () => {
      const h = makeHarness({ feed: makeFeed(), modelText: '{"shouldReply":true,"text":" 收到 "}' });
      await h.agent.generateCommentReply("moment_p1", "c2");
      expect(h.commitComment).toHaveBeenCalledWith({ postId: "moment_p1", content: "收到", replyTo: "c2" });
    });

    it("skip 决策不提交评论", async () => {
      const h = makeHarness({ feed: makeFeed(), modelText: '{"shouldReply":false,"text":""}' });
      await h.agent.generateCommentReply("moment_p1", "c2");
      expect(h.commitComment).not.toHaveBeenCalled();
    });

    it("模型调用失败时静默放弃", async () => {
      const h = makeHarness({ feed: makeFeed(), modelOutput: { kind: "error", reason: "network_error" } });
      await h.agent.generateCommentReply("moment_p1", "c2");
      expect(h.commitComment).not.toHaveBeenCalled();
    });
  });
});
// ── 主动发帖（Phase 4） ─────────────────────────────────────────

describe("parsePostDecision", () => {
  it("解析发帖决策（含 wantImage），文本 trim 后生效", () => {
    expect(parsePostDecision('{"shouldPost":true,"text":" 某个人终于收工啦 ","wantImage":true}'))
      .toEqual({ kind: "post", text: "某个人终于收工啦", wantImage: true });
    expect(parsePostDecision('{"shouldPost":true,"text":"今天很开心"}'))
      .toEqual({ kind: "post", text: "今天很开心", wantImage: false });
  });

  it("shouldPost=false 是 skip 而非错误", () => {
    expect(parsePostDecision('{"shouldPost":false,"text":""}')).toEqual({ kind: "skip" });
  });

  it("结构非法返回 invalid 并给出原因", () => {
    expect(parsePostDecision("oops")).toEqual({ kind: "invalid", reason: "invalid_json" });
    expect(parsePostDecision("[]")).toEqual({ kind: "invalid", reason: "invalid_shape" });
    expect(parsePostDecision('{"shouldPost":"maybe"}')).toEqual({ kind: "invalid", reason: "invalid_should_post" });
    expect(parsePostDecision('{"shouldPost":true,"text":"   "}')).toEqual({ kind: "invalid", reason: "empty_text" });
    expect(parsePostDecision(`{"shouldPost":true,"text":"${"长".repeat(301)}"}`))
      .toEqual({ kind: "invalid", reason: "text_too_long" });
  });
});

describe("buildPostGenerationMessages", () => {
  it("system 由人设与发帖指令拼接，user 携带摘录/最近动态/时间与 JSON 约定", () => {
    const recent = makePost({
      id: "moment_cy",
      author: "cyrene",
      text: "之前发过的动态",
      createdAt: new Date("2026-09-03T22:10:00").getTime(),
    });
    const messages = buildPostGenerationMessages({
      persona: PERSONA,
      summary: "[19:00] 用户：折腾好久了\n[19:01] 昔涟：快好了",
      recentCyrenePosts: [recent],
      localNow: new Date("2026-09-04T19:02:00"),
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(PERSONA);
    expect(messages[0].content).toContain("[moments_post_system]");
    const user = String(messages[1].content);
    expect(user).toContain("[最近对话摘录]");
    expect(user).toContain("[19:00] 用户：折腾好久了");
    expect(user).toContain("[你最近发过的动态]");
    expect(user).toContain("之前发过的动态");
    expect(user).toContain("[当前时间]");
    expect(user).toContain("2026-09-04 19:02 周五");
    expect(user).toContain('"shouldPost"');
  });

  it("无历史动态时显示（暂无）", () => {
    const messages = buildPostGenerationMessages({
      persona: PERSONA,
      summary: "对话摘录",
      recentCyrenePosts: [],
      localNow: new Date("2026-09-04T19:02:00"),
    });
    expect(String(messages[1].content)).toContain("[你最近发过的动态]\n（暂无）");
  });
});
describe("createMomentsAgent 主动发帖", () => {
  function makePostHarness(overrides: {
    modelText?: string;
    modelOutput?: { kind: "error"; reason: string };
    commitApplied?: boolean;
    /** 配图匹配结果；缺省 null（未命中 → 纯文字降级） */
    matchResult?: MomentMedia | null;
  }) {
    const runModel = vi.fn(
      async () => overrides.modelOutput ?? { kind: "text", text: overrides.modelText ?? "" },
    );
    const commitPost = vi.fn(async () => ({ applied: overrides.commitApplied ?? true }));
    const matchMedia = vi.fn(async () => overrides.matchResult ?? null);
    const log = vi.fn();
    const agent = createMomentsAgent({
      buildPersona: () => PERSONA,
      runModel,
      commitLike: vi.fn(async () => undefined),
      commitComment: vi.fn(async () => undefined),
      commitPost,
      loadFeedItem: vi.fn(() => null),
      matchMedia,
      log,
    });
    return { agent, runModel, commitPost, matchMedia, log };
  }

  it("发帖决策成功时提交动态并把摘录固化为 triggerExcerpt", async () => {
    const h = makePostHarness({ modelText: '{"shouldPost":true,"text":"有人终于肯收工啦","wantImage":true}' });
    const posted = await h.agent.generatePost({
      summary: "[23:30] 用户：修完了\n[23:30] 昔涟：太棒了",
      recentCyrenePosts: [],
    });

    expect(posted).toBe(true);
    expect(h.commitPost).toHaveBeenCalledWith({
      text: "有人终于肯收工啦",
      media: [],
      source: { type: "conversation", triggerExcerpt: "[23:30] 用户：修完了\n[23:30] 昔涟：太棒了" },
    });
  });

  it("wantImage=true 且素材命中时提交带图动态", async () => {
    const media: MomentMedia = {
      id: "media_asset_desk-night-01",
      type: "image",
      origin: "character_asset",
      ref: "desk-night-01.jpg",
    };
    const h = makePostHarness({
      modelText: '{"shouldPost":true,"text":"深夜赶工终于收工啦","wantImage":true}',
      matchResult: media,
    });

    const posted = await h.agent.generatePost({ summary: "深夜修完了", recentCyrenePosts: [] });

    expect(posted).toBe(true);
    expect(h.matchMedia).toHaveBeenCalledTimes(1);
    // 查询由动态文案 + 触发摘录拼成
    expect(h.matchMedia.mock.calls[0][0]).toContain("深夜赶工终于收工啦");
    expect(h.matchMedia.mock.calls[0][0]).toContain("深夜修完了");
    expect(h.commitPost).toHaveBeenCalledWith({
      text: "深夜赶工终于收工啦",
      media: [media],
      source: { type: "conversation", triggerExcerpt: "深夜修完了" },
    });
  });

  it("wantImage=true 但未命中素材时降级纯文字", async () => {
    const h = makePostHarness({ modelText: '{"shouldPost":true,"text":"文案","wantImage":true}' });
    await h.agent.generatePost({ summary: "摘录", recentCyrenePosts: [] });

    expect(h.matchMedia).toHaveBeenCalledTimes(1);
    expect(h.commitPost).toHaveBeenCalledWith({
      text: "文案",
      media: [],
      source: { type: "conversation", triggerExcerpt: "摘录" },
    });
  });

  it("wantImage=false 时不调用配图匹配", async () => {
    const h = makePostHarness({ modelText: '{"shouldPost":true,"text":"纯文字动态"}' });
    await h.agent.generatePost({ summary: "摘录", recentCyrenePosts: [] });

    expect(h.matchMedia).not.toHaveBeenCalled();
    expect(h.commitPost.mock.calls[0][0].media).toEqual([]);
  });

  it("skip 决策不提交且返回 false", async () => {
    const h = makePostHarness({ modelText: '{"shouldPost":false,"text":""}' });
    const posted = await h.agent.generatePost({ summary: "摘录", recentCyrenePosts: [] });
    expect(posted).toBe(false);
    expect(h.commitPost).not.toHaveBeenCalled();
  });

  it("决策无效时记录日志并返回 false", async () => {
    const h = makePostHarness({ modelText: "乱七八糟" });
    const posted = await h.agent.generatePost({ summary: "摘录", recentCyrenePosts: [] });
    expect(posted).toBe(false);
    expect(h.log).toHaveBeenCalledWith("post_decision_invalid", "invalid_json");
  });

  it("模型调用失败时静默返回 false", async () => {
    const h = makePostHarness({ modelOutput: { kind: "error", reason: "timeout" } });
    const posted = await h.agent.generatePost({ summary: "摘录", recentCyrenePosts: [] });
    expect(posted).toBe(false);
    expect(h.commitPost).not.toHaveBeenCalled();
  });

  it("提交被拒绝（开关关闭等）时返回 false", async () => {
    const h = makePostHarness({ modelText: '{"shouldPost":true,"text":"文案"}', commitApplied: false });
    const posted = await h.agent.generatePost({ summary: "摘录", recentCyrenePosts: [] });
    expect(posted).toBe(false);
  });
});