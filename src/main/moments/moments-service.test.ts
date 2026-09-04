// moments-service 调度测试：反应闸门前置、任务入队、评论触发范围与错误隔离；
// 主动发帖调度：设置/去重闸门前置、执行时复核冷却、成功落库与记账。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorConfig } from "../orchestrator/vendors";
import type { MomentsModelOutput } from "./moments-agent";
import { defaultMomentsPolicyState, type MomentsPolicyState } from "./moments-policy";
import type {
  MomentAuthor,
  MomentComment,
  MomentCommitResult,
  MomentCreateCommentInput,
  MomentCreatePostInput,
  MomentFeedItem,
  MomentMedia,
  MomentPost,
  MomentPostSource,
} from "../../shared/moments-types";

const mocks = vi.hoisted(() => ({
  enqueueLLMTask: vi.fn(),
  loadGeneralSettings: vi.fn(),
  loadModelSettings: vi.fn(),
  loadPromptFile: vi.fn(),
  getEmbeddingProvider: vi.fn(),
}));

vi.mock("../llm-queue", () => ({ enqueueLLMTask: mocks.enqueueLLMTask }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: mocks.loadGeneralSettings }));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: mocks.loadModelSettings }));
vi.mock("../rag/embedding", () => ({
  getEmbeddingProvider: mocks.getEmbeddingProvider,
  getEmbeddingProviderIdentity: async () => ({ provider: "local", model: "test", dimensions: 2 }),
}));
// sticker-storage 引 electron，且 resolveMomentStickerMedia 要读用户贴图 manifest——mock 掉
vi.mock("../sticker-storage", () => ({
  loadUserStickerManifest: () => ({ "my-cat": { file: "my-cat.png" } }),
}));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: mocks.loadPromptFile }));
vi.mock("../orchestrator/vendors", () => ({ getAdapterForConfig: vi.fn() }));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn(), recordRequest: vi.fn() }));
vi.mock("./moments-store", () => ({
  listFeed: vi.fn(),
  getFeedItem: vi.fn(),
  createUserPost: vi.fn(),
  deletePost: vi.fn(),
  createComment: vi.fn(),
  toggleLike: vi.fn(),
  createCyreneLike: vi.fn(),
  createCyrenePost: vi.fn(),
}));

import {
  createMomentsMediaMatcher,
  createMomentsService,
  registerMomentsMediaMatcher,
  type MomentsTurnInput,
} from "./moments-service";

function makePost(overrides: Partial<MomentPost> = {}): MomentPost {
  return {
    id: "moment_p1",
    author: "user",
    text: "用户动态",
    media: [],
    createdAt: 1_000,
    ...overrides,
  };
}

function makeComment(overrides: Partial<MomentComment> = {}): MomentComment {
  return {
    id: "comment_c1",
    postId: "moment_p1",
    author: "user",
    content: "评论",
    createdAt: 2_000,
    ...overrides,
  };
}

function makeTurnInput(overrides: Partial<MomentsTurnInput> = {}): MomentsTurnInput {
  return {
    conversationId: "chat-main",
    runId: "run-1",
    source: "desktop",
    mode: "chat",
    userText: "终于把构建修好了",
    assistantReply: "太好了，辛苦啦",
    finishedAt: new Date("2026-09-04T19:00:00").getTime(),
    ...overrides,
  };
}

interface FakeStoreState {
  posts: MomentPost[];
  comments: MomentComment[];
  cyreneLikes: string[];
  cyreneComments: Array<{ postId: string; content: string; replyTo?: string }>;
  cyrenePosts: Array<{ text: string; source?: MomentPostSource }>;
  rejectNextPost: boolean;
  rejectNextCyrenePost: boolean;
}

/** 内存版 store：记录昔涟提交，可预置动态与评论、可制造下一次发帖失败。 */
function createFakeStore() {
  const state: FakeStoreState = {
    posts: [],
    comments: [],
    cyreneLikes: [],
    cyreneComments: [],
    cyrenePosts: [],
    rejectNextPost: false,
    rejectNextCyrenePost: false,
  };

  const store = {
    listFeed: (): MomentFeedItem[] => [],
    getFeedItem: (postId: string): MomentFeedItem | null => {
      const post = state.posts.find((item) => item.id === postId);
      if (!post) return null;
      return { post, comments: state.comments.filter((c) => c.postId === postId), likes: [] };
    },
    createUserPost: async (input: MomentCreatePostInput): Promise<MomentCommitResult<MomentPost>> => {
      if (state.rejectNextPost) {
        state.rejectNextPost = false;
        return { applied: false, reason: "invalid_input" };
      }
      const post: MomentPost = {
        id: `moment_post${state.posts.length + 1}`,
        author: "user",
        title: input.title,
        text: input.text,
        media: [],
        createdAt: 1_000,
      };
      state.posts.push(post);
      return { applied: true, value: post };
    },
    deletePost: async (): Promise<MomentCommitResult<null>> => ({ applied: true, value: null }),
    createComment: async (
      input: MomentCreateCommentInput,
      author: MomentAuthor,
    ): Promise<MomentCommitResult<MomentComment>> => {
      const comment: MomentComment = {
        id: `comment_c${state.comments.length + 1}`,
        postId: input.postId,
        author,
        content: input.content,
        replyTo: input.replyTo,
        createdAt: 2_000,
      };
      state.comments.push(comment);
      if (author === "cyrene") {
        state.cyreneComments.push({ postId: input.postId, content: input.content, replyTo: input.replyTo });
      }
      return { applied: true, value: comment };
    },
    toggleLike: async (): Promise<MomentCommitResult<{ liked: boolean }>> => ({
      applied: true,
      value: { liked: true },
    }),
    createCyreneLike: async (postId: string): Promise<MomentCommitResult<{ liked: true }>> => {
      state.cyreneLikes.push(postId);
      return { applied: true, value: { liked: true } };
    },
    createCyrenePost: async (input: {
      title?: string;
      text: string;
      media?: MomentMedia[];
      source?: MomentPostSource;
    }): Promise<MomentCommitResult<MomentPost>> => {
      if (state.rejectNextCyrenePost) {
        state.rejectNextCyrenePost = false;
        return { applied: false, reason: "moments_disabled" };
      }
      const post: MomentPost = {
        id: `moment_cy${state.posts.length + 1}`,
        author: "cyrene",
        text: input.text,
        media: input.media ?? [],
        createdAt: 3_000,
        source: input.source,
      };
      state.posts.push(post);
      state.cyrenePosts.push({ text: input.text, source: input.source });
      return { applied: true, value: post };
    },
  };
  return { store, state };
}
interface HarnessOptions {
  momentsEnabled?: boolean;
  cyreneMomentsReactionsEnabled?: boolean;
  cyreneMomentsPostingEnabled?: boolean;
  /** null 表示模型未配置；缺省为已配置 */
  vendorConfig?: VendorConfig | null;
  modelResponse?: string;
  /** 配图匹配（未注入时走默认闭包恒 null，纯文字落库） */
  matchMedia?: (query: string) => Promise<MomentMedia | null>;
}

/** enqueueTask 默认内联执行，便于断言反应链路完整生效。 */
function createHarness(options: HarnessOptions = {}) {
  const labels: string[] = [];
  const runModel = vi.fn(
    async (): Promise<MomentsModelOutput> => ({
      kind: "text",
      text: options.modelResponse ?? '{"like":true,"comment":{"shouldComment":false}}',
    }),
  );
  const log = vi.fn();
  const enqueueTask = vi.fn(async (label: string, task: () => Promise<void>) => {
    labels.push(label);
    await task();
  });
  const fake = createFakeStore();
  // 设置做成可变对象：同一 harness 内可中途打开开关，模拟"先关后开"的调度行为
  const settings = {
    momentsEnabled: options.momentsEnabled ?? true,
    cyreneMomentsReactionsEnabled: options.cyreneMomentsReactionsEnabled ?? true,
    cyreneMomentsPostingEnabled: options.cyreneMomentsPostingEnabled ?? false,
  };
  // 策略状态用内存版，测试不落盘也不碰 electron
  const policy: { current: MomentsPolicyState } = { current: defaultMomentsPolicyState() };
  const service = createMomentsService({
    store: fake.store,
    loadGeneralSettings: () => settings,
    loadVendorConfig: () =>
      options.vendorConfig === undefined
        ? ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" } as VendorConfig)
        : options.vendorConfig,
    matchMedia: options.matchMedia,
    buildPersona: () => "测试人设",
    enqueueTask,
    runModel,
    loadPolicyState: () => policy.current,
    savePolicyState: (state: MomentsPolicyState) => {
      policy.current = state;
    },
    log,
  });
  return { service, fake, labels, runModel, log, enqueueTask, settings, policy };
}

/** scheduleTurn 是同步入口，任务体里的 await 需要等一拍再断言。 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("moments service 反应调度", () => {
  it("用户发帖成功后调度昔涟反应任务并完成点赞提交", async () => {
    const h = createHarness();
    const result = await h.service.createUserPost({ text: "第一条动态" });

    expect(result.applied).toBe(true);
    expect(h.labels).toEqual(["MomentsReact"]);
    expect(h.runModel).toHaveBeenCalledTimes(1);
    expect(h.fake.state.cyreneLikes).toHaveLength(1);
    expect(h.fake.state.cyreneComments).toHaveLength(0);
  });

  it("反应总开关关闭时 CRUD 照常、不调度任务", async () => {
    const h = createHarness({ momentsEnabled: false });
    const result = await h.service.createUserPost({ text: "不触发反应" });

    expect(result.applied).toBe(true);
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("反应子开关关闭时不调度任务", async () => {
    const h = createHarness({ cyreneMomentsReactionsEnabled: false });
    await h.service.createUserPost({ text: "x" });
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("模型未配置（缺 API key）时不调度任务", async () => {
    const h = createHarness({ vendorConfig: null });
    await h.service.createUserPost({ text: "x" });
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("发帖被拒绝时不调度反应", async () => {
    const h = createHarness();
    h.fake.state.rejectNextPost = true;

    const result = await h.service.createUserPost({ text: "" });
    expect(result.applied).toBe(false);
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("模型调用出错时任务静默结束，不产生任何提交", async () => {
    const h = createHarness();
    h.runModel.mockResolvedValue({ kind: "error", reason: "timeout" });

    await h.service.createUserPost({ text: "x" });
    expect(h.labels).toEqual(["MomentsReact"]);
    expect(h.fake.state.cyreneLikes).toHaveLength(0);
    expect(h.fake.state.cyreneComments).toHaveLength(0);
  });
});

describe("moments service 评论回复调度", () => {
  it("回复昔涟评论的用户评论触发 MomentsReply 并落库回复", async () => {
    const h = createHarness({ modelResponse: '{"shouldReply":true,"text":"收到啦"}' });
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "user" }));
    h.fake.state.comments.push(makeComment({ id: "c_cyrene", postId: "moment_p1", author: "cyrene" }));

    const result = await h.service.createUserComment({
      postId: "moment_p1",
      content: "回复昔涟",
      replyTo: "c_cyrene",
    });

    expect(result.applied).toBe(true);
    expect(h.labels).toEqual(["MomentsReply"]);
    // 用户评论落库后 id 为 comment_c2，昔涟回复携带 replyTo 指向它
    expect(h.fake.state.cyreneComments).toEqual([{ postId: "moment_p1", content: "收到啦", replyTo: "comment_c2" }]);
  });

  it("在昔涟动态下的顶级评论同样触发回复", async () => {
    const h = createHarness({ modelResponse: '{"shouldReply":false,"text":""}' });
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "cyrene" }));

    await h.service.createUserComment({ postId: "moment_p1", content: "顶级评论" });
    expect(h.labels).toEqual(["MomentsReply"]);
    expect(h.fake.state.cyreneComments).toHaveLength(0);
  });

  it("用户动态下回复用户自己的评论不触发回复", async () => {
    const h = createHarness();
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "user" }));
    h.fake.state.comments.push(makeComment({ id: "c_user", postId: "moment_p1", author: "user" }));

    const result = await h.service.createUserComment({ postId: "moment_p1", content: "用户回用户", replyTo: "c_user" });
    expect(result.applied).toBe(true);
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("触发回复的目标评论已不存在时不入队", async () => {
    const h = createHarness();
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "cyrene" }));

    // 动态存在但回复目标不存在：调度前 getFeedItem 找不到目标评论则不调度
    await h.service.createUserComment({ postId: "moment_post9", content: "评论" });
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });
});

describe("moments service 主动发帖调度", () => {
  it("主动发帖开关关闭时不调度，但 ring buffer 仍记录历史轮次", async () => {
    const h = createHarness({
      cyreneMomentsPostingEnabled: false,
      modelResponse: '{"shouldPost":true,"text":"值得记录"}',
    });
    h.service.scheduleTurn(makeTurnInput({ runId: "run-1", userText: "第一轮内容" }));
    expect(h.enqueueTask).not.toHaveBeenCalled();

    // 中途打开开关：后续轮次的摘录应包含关闭期间记录的对话
    h.settings.cyreneMomentsPostingEnabled = true;
    h.service.scheduleTurn(makeTurnInput({ runId: "run-2", userText: "第二轮内容", finishedAt: new Date("2026-09-04T19:30:00").getTime() }));
    await flush();

    expect(h.labels).toEqual(["MomentsPost"]);
    const committed = h.fake.state.cyrenePosts[0];
    expect(committed.source?.triggerExcerpt).toContain("第一轮内容");
    expect(committed.source?.triggerExcerpt).toContain("第二轮内容");
  });

  it("模型未配置时不调度任务", async () => {
    const h = createHarness({ cyreneMomentsPostingEnabled: true, vendorConfig: null });
    h.service.scheduleTurn(makeTurnInput());
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("完整链路：入队生成、落库动态并记录策略状态", async () => {
    const h = createHarness({
      cyreneMomentsPostingEnabled: true,
      modelResponse: '{"shouldPost":true,"text":"收工啦，值得纪念"}',
    });
    h.service.scheduleTurn(makeTurnInput());
    await flush();

    expect(h.labels).toEqual(["MomentsPost"]);
    expect(h.runModel).toHaveBeenCalledTimes(1);
    expect(h.fake.state.cyrenePosts).toHaveLength(1);
    expect(h.fake.state.cyrenePosts[0]).toMatchObject({
      text: "收工啦，值得纪念",
      source: { type: "conversation" },
    });
    // 发帖成功后记账：冷却起点刷新、当日计数 +1
    expect(h.policy.current.lastPostAt).not.toBeNull();
    expect(h.policy.current.postsToday.count).toBe(1);
  });

  it("run 粒度去重：同一 runId 重复到达直接丢弃", async () => {
    const h = createHarness({ cyreneMomentsPostingEnabled: true });
    h.service.scheduleTurn(makeTurnInput({ runId: "run-dup" }));
    await flush();
    h.service.scheduleTurn(makeTurnInput({ runId: "run-dup" }));
    await flush();

    expect(h.labels).toEqual(["MomentsPost"]);
    expect(h.runModel).toHaveBeenCalledTimes(1);
  });

  it("不同 runId 各自有效，但执行时复核冷却只放行第一条", async () => {
    const h = createHarness({
      cyreneMomentsPostingEnabled: true,
      modelResponse: '{"shouldPost":true,"text":"第一条"}',
    });
    h.service.scheduleTurn(makeTurnInput({ runId: "run-1" }));
    await flush();
    h.service.scheduleTurn(makeTurnInput({ runId: "run-2" }));
    await flush();

    expect(h.labels).toEqual(["MomentsPost", "MomentsPost"]);
    // 第二条任务因冷却被复核拦截，只有一条动态落库
    expect(h.fake.state.cyrenePosts).toHaveLength(1);
    expect(h.log).toHaveBeenCalledWith("post_gated", "cooldown");
  });

  it("任务执行时处于冷却期则不调用模型，仅记录日志", async () => {
    const h = createHarness({ cyreneMomentsPostingEnabled: true });
    h.policy.current = { ...defaultMomentsPolicyState(), lastPostAt: Date.now() - 60_000 };
    h.service.scheduleTurn(makeTurnInput());
    await flush();

    expect(h.labels).toEqual(["MomentsPost"]);
    expect(h.runModel).not.toHaveBeenCalled();
    expect(h.fake.state.cyrenePosts).toHaveLength(0);
    expect(h.log).toHaveBeenCalledWith("post_gated", "cooldown");
  });

  it("skip 决策不提交动态也不记账", async () => {
    const h = createHarness({
      cyreneMomentsPostingEnabled: true,
      modelResponse: '{"shouldPost":false,"text":""}',
    });
    h.service.scheduleTurn(makeTurnInput());
    await flush();

    expect(h.fake.state.cyrenePosts).toHaveLength(0);
    expect(h.policy.current.lastPostAt).toBeNull();
    expect(h.policy.current.postsToday.count).toBe(0);
  });

  it("提交被拒（开关在提交时刻关闭）时不记账", async () => {
    const h = createHarness({
      cyreneMomentsPostingEnabled: true,
      modelResponse: '{"shouldPost":true,"text":"文案"}',
    });
    h.fake.state.rejectNextCyrenePost = true;
    h.service.scheduleTurn(makeTurnInput());
    await flush();

    expect(h.fake.state.cyrenePosts).toHaveLength(0);
    expect(h.policy.current.lastPostAt).toBeNull();
  });
});

describe("moments service 错误隔离", () => {
  it("入队失败被记录且不影响用户操作返回", async () => {
    const h = createHarness();
    h.enqueueTask.mockRejectedValue(new Error("队列炸了"));

    const result = await h.service.createUserPost({ text: "x" });
    expect(result.applied).toBe(true);

    // catch 在微任务里结算，等一拍再断言日志
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toHaveBeenCalledWith("reaction_task_failed", "队列炸了");
  });

  it("主动发帖任务失败被记录且不记账", async () => {
    const h = createHarness({ cyreneMomentsPostingEnabled: true });
    h.enqueueTask.mockRejectedValue(new Error("发帖队列炸了"));
    h.service.scheduleTurn(makeTurnInput());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toHaveBeenCalledWith("post_task_failed", "发帖队列炸了");
    expect(h.policy.current.lastPostAt).toBeNull();
  });
});

describe("moments service 配图接线", () => {
  const MEDIA: MomentMedia = {
    id: "media_asset_night-sky-01",
    type: "image",
    origin: "character_asset",
    ref: "night-sky-01.jpg",
  };

  it("注入的 matchMedia 命中时主动动态带图落库", async () => {
    const matchMedia = vi.fn(async () => MEDIA);
    const h = createHarness({
      cyreneMomentsPostingEnabled: true,
      modelResponse: '{"shouldPost":true,"text":"今晚的夜空很好看","wantImage":true}',
      matchMedia,
    });

    h.service.scheduleTurn(makeTurnInput());
    await flush();

    expect(matchMedia).toHaveBeenCalledTimes(1);
    expect(typeof matchMedia.mock.calls[0][0]).toBe("string");
    const cyrenePost = h.fake.state.posts.find((post) => post.author === "cyrene");
    expect(cyrenePost?.media).toEqual([MEDIA]);
  });

  it("未注入 matchMedia 时纯文字落库（默认闭包恒 null）", async () => {
    const h = createHarness({
      cyreneMomentsPostingEnabled: true,
      modelResponse: '{"shouldPost":true,"text":"随手记一笔","wantImage":true}',
    });

    h.service.scheduleTurn(makeTurnInput());
    await flush();

    const cyrenePost = h.fake.state.posts.find((post) => post.author === "cyrene");
    expect(cyrenePost?.media).toEqual([]);
  });
});

describe("createMomentsMediaMatcher 具体闭包", () => {
  /** 查询向量恒为 [1,0]，与贴图向量算余弦便于构造精确分数 */
  const provider = {
    name: "test-provider",
    dims: 2,
    embed: async () => [1, 0],
    embedBatch: async (texts: string[]) => texts.map(() => [1, 0] as number[]),
  };

  beforeEach(() => {
    mocks.getEmbeddingProvider.mockReset();
    mocks.loadModelSettings.mockReset();
    // 复位晚绑定索引：避免上一条用例注册的索引泄漏到下一条
    registerMomentsMediaMatcher({ getStickerIndex: () => null });
  });

  it("provider 与贴图索引就绪且达阈值时产出内置贴图媒体", async () => {
    mocks.getEmbeddingProvider.mockReturnValue(provider);
    registerMomentsMediaMatcher({ getStickerIndex: () => [{ id: "sleepynow", embedding: [1, 0] }] });
    mocks.loadModelSettings.mockReturnValue({ stickerSimilarityThreshold: 0.55 });

    const media = await createMomentsMediaMatcher()("深夜好困");

    expect(media).toEqual({
      id: "media_sticker_sleepynow",
      type: "image",
      origin: "character_asset",
      ref: "stickers/sleepynow.jpg",
    });
  });

  it("命中用户贴图时产出 local-sticker 媒体引用", async () => {
    mocks.getEmbeddingProvider.mockReturnValue(provider);
    registerMomentsMediaMatcher({ getStickerIndex: () => [{ id: "my-cat", embedding: [1, 0] }] });
    mocks.loadModelSettings.mockReturnValue({ stickerSimilarityThreshold: 0.55 });

    const media = await createMomentsMediaMatcher()("看看猫猫");

    expect(media).toEqual({
      id: "media_sticker_my-cat",
      type: "image",
      origin: "character_asset",
      ref: "local-sticker:///my-cat.png",
    });
  });

  it("embedding provider 未就绪时降级 null", async () => {
    registerMomentsMediaMatcher({ getStickerIndex: () => [{ id: "sleepynow", embedding: [1, 0] }] });

    expect(await createMomentsMediaMatcher()("深夜")).toBeNull();
  });

  it("贴图索引未注册 / 未就绪时降级 null", async () => {
    mocks.getEmbeddingProvider.mockReturnValue(provider);

    expect(await createMomentsMediaMatcher()("深夜")).toBeNull();
  });

  it("最高分低于设置阈值时降级 null", async () => {
    mocks.getEmbeddingProvider.mockReturnValue(provider);
    registerMomentsMediaMatcher({ getStickerIndex: () => [{ id: "sleepynow", embedding: [0, 1] }] });
    mocks.loadModelSettings.mockReturnValue({ stickerSimilarityThreshold: 0.55 });

    expect(await createMomentsMediaMatcher()("深夜")).toBeNull();
  });
});