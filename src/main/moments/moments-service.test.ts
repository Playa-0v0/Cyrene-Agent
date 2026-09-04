// moments-service 调度测试：反应闸门前置、任务入队、评论触发范围与错误隔离。
import { describe, expect, it, vi } from "vitest";
import type { VendorConfig } from "../orchestrator/vendors";
import type { MomentsModelOutput } from "./moments-agent";
import type {
  MomentAuthor,
  MomentComment,
  MomentCommitResult,
  MomentCreateCommentInput,
  MomentCreatePostInput,
  MomentFeedItem,
  MomentPost,
} from "../../shared/moments-types";

const mocks = vi.hoisted(() => ({
  enqueueLLMTask: vi.fn(),
  loadGeneralSettings: vi.fn(),
  loadModelSettings: vi.fn(),
  loadPromptFile: vi.fn(),
}));

vi.mock("../llm-queue", () => ({ enqueueLLMTask: mocks.enqueueLLMTask }));
vi.mock("../settings/settings-facade", () => ({ loadGeneralSettings: mocks.loadGeneralSettings }));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: mocks.loadModelSettings }));
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

import { createMomentsService } from "./moments-service";

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

interface FakeStoreState {
  posts: MomentPost[];
  comments: MomentComment[];
  cyreneLikes: string[];
  cyreneComments: Array<{ postId: string; content: string; replyTo?: string }>;
  rejectNextPost: boolean;
}

/** 内存版 store：记录昔涟提交，可预置动态与评论、可制造下一次发帖失败。 */
function createFakeStore() {
  const state: FakeStoreState = {
    posts: [],
    comments: [],
    cyreneLikes: [],
    cyreneComments: [],
    rejectNextPost: false,
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
  };
  return { store, state };
}
interface HarnessOptions {
  momentsEnabled?: boolean;
  cyreneMomentsReactionsEnabled?: boolean;
  /** null 表示模型未配置；缺省为已配置 */
  vendorConfig?: VendorConfig | null;
  modelResponse?: string;
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
  const service = createMomentsService({
    store: fake.store,
    loadGeneralSettings: () => ({
      momentsEnabled: options.momentsEnabled ?? true,
      cyreneMomentsReactionsEnabled: options.cyreneMomentsReactionsEnabled ?? true,
    }),
    loadVendorConfig: () =>
      options.vendorConfig === undefined
        ? ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" } as VendorConfig)
        : options.vendorConfig,
    buildPersona: () => "测试人设",
    enqueueTask,
    runModel,
    log,
  });
  return { service, fake, labels, runModel, log, enqueueTask };
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
});