// moments-service 调度测试：昔涟反应任务入队（闸门前置、在线/深夜延迟、
// 到期扫描后决策落库、退避重试与作废语义）；主动发帖调度：设置/去重闸门前置、
// 执行时复核冷却、成功落库与记账。
import fs from "fs";
import os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorConfig } from "../orchestrator/vendors";
import type { CharacterPersona } from "./character-personas";
import type { MomentPostImage, MomentsModelOutput } from "./moments-agent";
import { defaultMomentsPolicyState, type MomentsPolicyState } from "./moments-policy";
import type {
  ApplyCommentResult,
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
  getPermanentWorldbookEntries: vi.fn(),
  getKeywordMatchedWorldbookEntries: vi.fn(),
  validateCaptionImagePath: vi.fn(),
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
  getMomentsMediaRootDir: () => "/moments-media",
}));
// worldbook 关键词直查 + 图片校验都 mock 掉，只测 moments 侧接线
vi.mock("../rag", () => ({
  getPermanentWorldbookEntries: mocks.getPermanentWorldbookEntries,
  getKeywordMatchedWorldbookEntries: mocks.getKeywordMatchedWorldbookEntries,
}));
vi.mock("../chat/image-caption", () => ({
  validateCaptionImagePath: mocks.validateCaptionImagePath,
}));

import {
  buildMomentsWorldbookContext,
  createMomentsMediaMatcher,
  createMomentsService,
  loadUserMomentPostImages,
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

/** 反应队列临时持久化文件：每个 harness 独立一份，互不串扰 */
function tempQueueFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-moments-service-")), "moments-reaction-queue.json");
}

/** 读队列落盘文件里的任务快照（入队即落盘；文件尚不存在说明从未入队，视作空队列） */
function readQueueTasks(filePath: string): Array<{
  kind: string;
  actor: string;
  postId: string;
  triggerCommentId?: string;
  dueAt: number;
}> {
  try {
    return (JSON.parse(fs.readFileSync(filePath, "utf8")) as { tasks: unknown[] }).tasks as never;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

interface FakeStoreState {
  posts: MomentPost[];
  comments: MomentComment[];
  cyreneLikes: string[];
  cyreneComments: Array<{ postId: string; content: string; replyTo?: string }>;
  cyrenePosts: Array<{ text: string; source?: MomentPostSource }>;
  characterLikes: Array<{ nickname: string; postId: string }>;
  characterComments: Array<{ nickname: string; postId: string; content: string; replyTo?: string }>;
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
    characterLikes: [],
    characterComments: [],
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
        media: input.media ?? [],
        createdAt: 1_000,
      };
      state.posts.push(post);
      return { applied: true, value: post };
    },
    deletePost: async (): Promise<MomentCommitResult<null>> => ({ applied: true, value: null }),
    createComment: async (
      input: MomentCreateCommentInput,
      author: MomentAuthor,
      options: { sourceTaskId?: string } = {},
    ): Promise<MomentCommitResult<MomentComment>> => {
      // 镜像真实 store：同一反应任务的评论幂等，重跑返回既有评论
      if (options.sourceTaskId) {
        const existing = state.comments.find(
          (comment) => comment.postId === input.postId && comment.sourceTaskId === options.sourceTaskId,
        );
        if (existing) return { applied: true, value: existing };
      }
      const comment: MomentComment = {
        id: `comment_c${state.comments.length + 1}`,
        postId: input.postId,
        author,
        content: input.content,
        replyTo: input.replyTo,
        createdAt: 2_000,
        sourceTaskId: options.sourceTaskId,
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
    createCharacterLike: async (
      nickname: string,
      postId: string,
    ): Promise<MomentCommitResult<{ liked: true }>> => {
      state.characterLikes.push({ nickname, postId });
      return { applied: true, value: { liked: true } };
    },
    createCharacterComment: async (
      nickname: string,
      input: { postId: string; content: string; replyTo?: string; sourceTaskId?: string },
    ): Promise<ApplyCommentResult> => {
      // 镜像真实 store：同一反应任务的评论幂等，重跑返回既有评论供续接
      if (input.sourceTaskId) {
        const existing = state.comments.find(
          (comment) => comment.postId === input.postId && comment.sourceTaskId === input.sourceTaskId,
        );
        if (existing) return { status: "already_applied", comment: existing };
      }
      const comment: MomentComment = {
        id: `comment_c${state.comments.length + 1}`,
        postId: input.postId,
        author: nickname,
        content: input.content,
        replyTo: input.replyTo,
        createdAt: 4_000,
        sourceTaskId: input.sourceTaskId,
      };
      state.comments.push(comment);
      state.characterComments.push({
        nickname,
        postId: input.postId,
        content: input.content,
        replyTo: input.replyTo,
      });
      return { status: "created", comment };
    },
    getCharacterTimeline: () => ({ entries: [], truncatedComments: 0 }),
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
  /** worldbook 注入（缺省用真闭包，配合 mocked rag 断言全链路） */
  buildWorldbookContext?: (text: string) => string;
  /** 图片读取（缺省用真闭包，配合 mocked 校验函数断言全链路） */
  loadPostImages?: (post: MomentPost) => MomentPostImage[];
  /** 时钟起点（缺省本地中午 12 点——避开深夜窗口，测试不随时区漂移） */
  now?: number;
  /** 延迟抽签随机源（缺省恒 0.5：分桶与桶内取值都可预计算） */
  random?: () => number;
  /** 角色注册表（缺省空：角色链路整体静默，只测昔涟；角色用例显式注入） */
  loadPersonas?: () => Map<string, CharacterPersona>;
  /** 反应队列持久化路径（缺省临时文件；可指向非法路径模拟磁盘异常） */
  reactionQueueFilePath?: string;
}

// 全局默认：worldbook / 图片校验 mock 返回空，真闭包安全降级；个别用例按需覆盖
beforeEach(() => {
  mocks.getPermanentWorldbookEntries.mockReset().mockReturnValue([]);
  mocks.getKeywordMatchedWorldbookEntries.mockReset().mockReturnValue([]);
  mocks.validateCaptionImagePath.mockReset();
});

/** enqueueTask 默认内联执行，便于断言主动发帖链路完整生效。 */
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
  // 可控时钟：反应延迟与冷却复核都不依赖真实时间；默认本地中午，避开深夜窗口
  const clock = { now: options.now ?? new Date(2026, 8, 4, 12, 0, 0).getTime() };
  const queueFile = options.reactionQueueFilePath ?? tempQueueFile();
  const service = createMomentsService({
    store: fake.store,
    loadGeneralSettings: () => settings,
    loadVendorConfig: () =>
      options.vendorConfig === undefined
        ? ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" } as VendorConfig)
        : options.vendorConfig,
    matchMedia: options.matchMedia,
    buildWorldbookContext: options.buildWorldbookContext ?? buildMomentsWorldbookContext,
    loadPostImages: options.loadPostImages ?? loadUserMomentPostImages,
    buildPersona: () => "测试人设",
    enqueueTask,
    runModel,
    loadPolicyState: () => policy.current,
    savePolicyState: (state: MomentsPolicyState) => {
      policy.current = state;
    },
    reactionQueueFilePath: queueFile,
    now: () => clock.now,
    random: options.random ?? (() => 0.5),
    loadPersonas: options.loadPersonas ?? (() => new Map()),
    log,
  });
  return { service, fake, labels, runModel, log, enqueueTask, settings, policy, clock, queueFile };
}

/** scheduleTurn 是同步入口，任务体里的 await 需要等一拍再断言。 */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("moments service 昔涟反应入队与到期执行", () => {
  it("用户发帖成功后表态任务入队，到期扫描后决策落库点赞", async () => {
    const h = createHarness();
    const result = await h.service.createUserPost({ text: "第一条动态" });

    expect(result.applied).toBe(true);
    // 到期前不执行：任务躺在队列里，模型未被调用
    expect(h.runModel).not.toHaveBeenCalled();
    const [task] = readQueueTasks(h.queueFile);
    expect(task).toMatchObject({ kind: "post_eval", actor: "cyrene", postId: "moment_post1" });

    // 离线长尾延迟（random 恒 0.5 落在 45~75 分钟桶取中值 60 分钟）：未到期先扫一轮不执行
    await h.service.drainReactionQueue();
    expect(h.runModel).not.toHaveBeenCalled();

    h.clock.now += 60 * 60_000;
    await h.service.drainReactionQueue();

    expect(h.runModel).toHaveBeenCalledTimes(1);
    expect(h.fake.state.cyreneLikes).toHaveLength(1);
    expect(h.fake.state.cyreneComments).toHaveLength(0);
    // 执行成功后任务出队并同步落盘清空
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("昔涟在线（最近对话收尾不足 10 分钟）时表态走短延迟，深夜入队也不推迟到早晨", async () => {
    const night = new Date(2026, 8, 4, 3, 0, 0).getTime();
    const h = createHarness({ now: night });
    // 主动发帖开关默认关：scheduleTurn 只记录 ring buffer，恰好是在线感知的原料
    h.service.scheduleTurn(makeTurnInput({ finishedAt: night }));

    await h.service.createUserPost({ text: "凌晨的动态" });
    const [task] = readQueueTasks(h.queueFile);

    // 在线短延迟 1~8 分钟直接生效，不套深夜窗口（用户正和昔涟聊天，她就是醒着的）
    expect(task.dueAt - night).toBeGreaterThanOrEqual(60_000);
    expect(task.dueAt - night).toBeLessThan(8 * 60_000);
  });

  it("深夜入队的离线任务整体推迟到次日早晨", async () => {
    const night = new Date(2026, 8, 4, 3, 0, 0).getTime();
    const h = createHarness({ now: night });

    await h.service.createUserPost({ text: "凌晨的动态" });
    const [task] = readQueueTasks(h.queueFile);

    // 离线正常延迟落在 4:00，但深夜窗口把它替换为 8:00 + random(0.5)*120 分钟 = 9:00
    expect(task.dueAt).toBe(new Date(2026, 8, 4, 9, 0, 0).getTime());
  });

  it("反应总开关关闭时 CRUD 照常、不入队反应任务", async () => {
    const h = createHarness({ momentsEnabled: false });
    const result = await h.service.createUserPost({ text: "不触发反应" });

    expect(result.applied).toBe(true);
    expect(readQueueTasks(h.queueFile)).toEqual([]);
    expect(h.enqueueTask).not.toHaveBeenCalled();
  });

  it("反应子开关关闭时不入队任务", async () => {
    const h = createHarness({ cyreneMomentsReactionsEnabled: false });
    await h.service.createUserPost({ text: "x" });
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("模型未配置（缺 API key）时不入队任务", async () => {
    const h = createHarness({ vendorConfig: null });
    await h.service.createUserPost({ text: "x" });
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("发帖被拒绝时不调度反应", async () => {
    const h = createHarness();
    h.fake.state.rejectNextPost = true;

    const result = await h.service.createUserPost({ text: "" });
    expect(result.applied).toBe(false);
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("到期执行时反应开关已关闭：任务作废且不调模型", async () => {
    const h = createHarness();
    await h.service.createUserPost({ text: "x" });
    // 入队后用户关掉开关：执行时闸门复核不通过，任务按世界已变作废
    h.settings.cyreneMomentsReactionsEnabled = false;

    h.clock.now += 60 * 60_000;
    await h.service.drainReactionQueue();

    expect(h.runModel).not.toHaveBeenCalled();
    expect(readQueueTasks(h.queueFile)).toEqual([]);
    expect(h.log).toHaveBeenCalledWith("reaction_task_stale", expect.objectContaining({ reason: "reactions_disabled" }));
  });

  it("到期前动态被删除：任务作废且不调模型", async () => {
    const h = createHarness();
    await h.service.createUserPost({ text: "x" });
    h.fake.state.posts.length = 0;

    h.clock.now += 60 * 60_000;
    await h.service.drainReactionQueue();

    expect(h.runModel).not.toHaveBeenCalled();
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("模型供应商失败时任务按退避梯度重试，恢复后完成表态", async () => {
    const h = createHarness();
    h.runModel.mockResolvedValueOnce({ kind: "error", reason: "timeout" });
    await h.service.createUserPost({ text: "x" });

    h.clock.now += 60 * 60_000;
    await h.service.drainReactionQueue();
    // 第一次失败：任务保留并退避 5 分钟，不放弃
    expect(h.runModel).toHaveBeenCalledTimes(1);
    expect(readQueueTasks(h.queueFile)).toHaveLength(1);

    h.clock.now += 5 * 60_000;
    await h.service.drainReactionQueue();
    // 退避期满重试成功：决策落库，任务删除
    expect(h.runModel).toHaveBeenCalledTimes(2);
    expect(h.fake.state.cyreneLikes).toHaveLength(1);
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("反应任务落盘持久化：服务重建（模拟重启）后任务仍能到期执行", async () => {
    const queueFile = tempQueueFile();
    const first = createHarness({ reactionQueueFilePath: queueFile });
    const result = await first.service.createUserPost({ text: "重启前的动态" });
    const dueAt = readQueueTasks(queueFile)[0].dueAt;

    // 重建服务实例（同一队列文件）：重启后按落盘 dueAt 续接执行
    const second = createHarness({ reactionQueueFilePath: queueFile, now: dueAt });
    // store 在真实环境同样落盘恢复；测试里手动回放同一动态
    second.fake.state.posts.push(makePost({ id: result.value.id, text: "重启前的动态" }));
    await second.service.drainReactionQueue();

    expect(second.runModel).toHaveBeenCalledTimes(1);
    expect(second.fake.state.cyreneLikes).toEqual([result.value.id]);
    expect(readQueueTasks(queueFile)).toEqual([]);
  });
});

describe("moments service 评论回复调度", () => {
  it("回复昔涟评论的用户评论入队回复任务，到期落库回复", async () => {
    const h = createHarness({ modelResponse: '{"shouldReply":true,"text":"收到啦"}' });
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "user" }));
    h.fake.state.comments.push(makeComment({ id: "c_cyrene", postId: "moment_p1", author: "cyrene" }));

    const result = await h.service.createUserComment({
      postId: "moment_p1",
      content: "回复昔涟",
      replyTo: "c_cyrene",
    });

    expect(result.applied).toBe(true);
    // 用户评论落库后 id 为 comment_c2，回复任务的触发评论即它
    const [task] = readQueueTasks(h.queueFile);
    expect(task).toMatchObject({
      kind: "reply_eval",
      actor: "cyrene",
      postId: "moment_p1",
      triggerCommentId: "comment_c2",
    });

    // 离线回复延迟（random 恒 0.5 落在 35~55 分钟桶取中值 45 分钟）
    h.clock.now += 45 * 60_000;
    await h.service.drainReactionQueue();

    expect(h.runModel).toHaveBeenCalledTimes(1);
    expect(h.fake.state.cyreneComments).toEqual([{ postId: "moment_p1", content: "收到啦", replyTo: "comment_c2" }]);
  });

  it("在昔涟动态下的顶级评论同样入队回复任务，沉默决策不落库", async () => {
    const h = createHarness({ modelResponse: '{"shouldReply":false,"text":""}' });
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "cyrene" }));

    await h.service.createUserComment({ postId: "moment_p1", content: "顶级评论" });
    const [task] = readQueueTasks(h.queueFile);
    expect(task).toMatchObject({ kind: "reply_eval", postId: "moment_p1", triggerCommentId: "comment_c1" });

    h.clock.now += 45 * 60_000;
    await h.service.drainReactionQueue();

    // silent 无副作用，任务正常删除
    expect(h.fake.state.cyreneComments).toHaveLength(0);
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("用户动态下回复用户自己的评论不触发回复", async () => {
    const h = createHarness();
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "user" }));
    h.fake.state.comments.push(makeComment({ id: "c_user", postId: "moment_p1", author: "user" }));

    const result = await h.service.createUserComment({ postId: "moment_p1", content: "用户回用户", replyTo: "c_user" });
    expect(result.applied).toBe(true);
    expect(readQueueTasks(h.queueFile)).toEqual([]);
  });

  it("动态不存在时不入队回复任务", async () => {
    const h = createHarness();
    h.fake.state.posts.push(makePost({ id: "moment_p1", author: "cyrene" }));

    // 动态不存在：调度前 getFeedItem 找不到目标则不调度
    await h.service.createUserComment({ postId: "moment_post9", content: "评论" });
    expect(readQueueTasks(h.queueFile)).toEqual([]);
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
    h.policy.current = { ...defaultMomentsPolicyState(), lastPostAt: h.clock.now - 60_000 };
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
  it("反应入队失败（磁盘异常）只记日志，不影响用户发帖返回", async () => {
    // 队列文件的父路径是一个普通文件：mkdir 必然失败，模拟磁盘异常
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-moments-block-")), "blocker.txt");
    fs.writeFileSync(blocker, "not a directory");
    const h = createHarness({ reactionQueueFilePath: path.join(blocker, "queue.json") });

    const result = await h.service.createUserPost({ text: "x" });
    expect(result.applied).toBe(true);
    expect(h.log).toHaveBeenCalledWith("reaction_enqueue_failed", expect.any(String));
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

describe("moments worldbook 注入与图片读取", () => {
  beforeEach(() => {
    mocks.getPermanentWorldbookEntries.mockReset().mockReturnValue([]);
    mocks.getKeywordMatchedWorldbookEntries.mockReset().mockReturnValue([]);
    mocks.validateCaptionImagePath.mockReset();
    mocks.loadModelSettings.mockReset();
  });

  describe("buildMomentsWorldbookContext", () => {
    it("常驻条目全量 + 关键词命中条目按序合并", () => {
      mocks.getPermanentWorldbookEntries.mockReturnValue(["【常驻设定】全局背景"]);
      mocks.getKeywordMatchedWorldbookEntries.mockReturnValue(["【风堇】黄金裔"]);

      const result = buildMomentsWorldbookContext("提到风堇的文本");
      expect(result).toContain("[相关设定]");
      expect(result).toContain("【常驻设定】全局背景");
      expect(result).toContain("【风堇】黄金裔");
      expect(mocks.getKeywordMatchedWorldbookEntries).toHaveBeenCalledWith("提到风堇的文本");
    });
    it("两边都无内容时返回空串（不注入）", () => {
      expect(buildMomentsWorldbookContext("无关文本")).toBe("");
    });
  });

  describe("loadUserMomentPostImages", () => {
    it("user_attachment 副本读取成功时转 base64 dataUrl", () => {
      mocks.validateCaptionImagePath.mockReturnValue({
        ok: true,
        filePath: "/moments-media/moment_p1/1.jpg",
        buffer: Buffer.from("ABC"),
        mime: "image/jpeg",
      });

      const images = loadUserMomentPostImages(makePost({
        media: [{ id: "m1", type: "image", origin: "user_attachment", ref: "1.jpg" }],
      }));

      expect(mocks.validateCaptionImagePath).toHaveBeenCalledWith(path.join("/moments-media", "moment_p1", "1.jpg"));
      expect(images).toEqual([{ name: "1.jpg", dataUrl: "data:image/jpeg;base64,QUJD" }]);
    });

    it("读取失败时降级错误说明，不阻断", () => {
      mocks.validateCaptionImagePath.mockReturnValue({ ok: false, error: "文件不存在" });

      const images = loadUserMomentPostImages(makePost({
        media: [{ id: "m1", type: "image", origin: "user_attachment", ref: "1.jpg" }],
      }));

      expect(images).toEqual([{ name: "1.jpg", error: "文件不存在" }]);
    });

    it("character_asset 配图不作为视觉输入", () => {
      const images = loadUserMomentPostImages(makePost({
        media: [{ id: "m1", type: "image", origin: "character_asset", ref: "stickers/peek.gif" }],
      }));

      expect(images).toEqual([]);
      expect(mocks.validateCaptionImagePath).not.toHaveBeenCalled();
    });

    it("multimodal=false 时不读图（与主会话同一条开关规矩）", () => {
      mocks.loadModelSettings.mockReturnValue({ multimodal: false });

      const images = loadUserMomentPostImages(makePost({
        media: [{ id: "m1", type: "image", origin: "user_attachment", ref: "1.jpg" }],
      }));

      expect(images).toEqual([]);
      expect(mocks.validateCaptionImagePath).not.toHaveBeenCalled();
    });
  });
  it("注入链路：反应调用携带 worldbook 与图片进 prompt", async () => {
    mocks.getKeywordMatchedWorldbookEntries.mockReturnValue(["【风堇】黄金裔"]);
    mocks.validateCaptionImagePath.mockReturnValue({
      ok: true,
      filePath: "/moments-media/moment_p1/1.jpg",
      buffer: Buffer.from("ABC"),
      mime: "image/jpeg",
    });
    const h = createHarness({
      cyreneMomentsReactionsEnabled: true,
      modelResponse: '{"like":false,"comment":{"shouldComment":false}}',
    });
    const result = await h.service.createUserPost({
      text: "见到风堇了",
      media: [{ id: "m1", type: "image", origin: "user_attachment", ref: "1.jpg" }],
    });

    expect(result.applied).toBe(true);
    // 到期扫描后模型才被调用，prompt 在决策时组装
    h.clock.now += 60 * 60_000;
    await h.service.drainReactionQueue();

    const messages = h.runModel.mock.calls[0][0] as Array<{ role: string; content?: unknown }>;
    expect(mocks.getKeywordMatchedWorldbookEntries).toHaveBeenCalledWith("见到风堇了");
    expect(messages[0].content).toContain("【风堇】黄金裔");
    const blocks = messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.some((block) => block.type === "image_url" && block.image_url?.url === "data:image/jpeg;base64,QUJD")).toBe(true);
  });
});
