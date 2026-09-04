import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}));

function pngBytes(size = 16): ArrayBuffer {
  return new Uint8Array(size).fill(7).buffer;
}

async function freshStore() {
  const store = await import("./moments-store");
  store.initialize();
  return store;
}

describe("moments store", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-moments-"));
  });

  it("创建用户动态并按 createdAt 倒序出现在 feed", async () => {
    const store = await freshStore();
    const first = await store.createUserPost({ title: "标题", text: "第一条" });
    const second = await store.createUserPost({ text: "第二条" });

    expect(first.applied && first.value.author).toBe("user");
    expect(first.applied && first.value.title).toBe("标题");

    const feed = store.listFeed();
    expect(feed).toHaveLength(2);
    expect(feed[0].post.id).toBe(second.applied ? second.value.id : "");
    expect(feed[0].post.createdAt).toBeGreaterThanOrEqual(feed[1].post.createdAt);
  });

  it("拒绝空动态、超长文本、超量图片、非法 MIME 与超大图片", async () => {
    const store = await freshStore();

    expect(await store.createUserPost({ text: "   " })).toMatchObject({ applied: false, reason: "invalid_input" });
    expect(await store.createUserPost({ text: "x".repeat(2001) })).toMatchObject({ applied: false, reason: "invalid_input" });
    expect(
      await store.createUserPost({
        text: "图太多",
        images: Array.from({ length: 10 }, (_, i) => ({ name: `${i}.png`, mime: "image/png", bytes: pngBytes() })),
      }),
    ).toMatchObject({ applied: false, reason: "too_many_images" });
    expect(
      await store.createUserPost({ text: "gif 不支持", images: [{ name: "a.gif", mime: "image/gif", bytes: pngBytes() }] }),
    ).toMatchObject({ applied: false, reason: "unsupported_mime" });
    expect(
      await store.createUserPost({
        text: "太大",
        images: [{ name: "big.png", mime: "image/png", bytes: pngBytes(15 * 1024 * 1024 + 1) }],
      }),
    ).toMatchObject({ applied: false, reason: "image_too_large" });
  });

  it("带图动态把副本写入 moments-media/<postId>/ 并可在协议路径下解析", async () => {
    const store = await freshStore();
    const result = await store.createUserPost({
      text: "带图",
      images: [{ name: "photo.png", mime: "image/png", bytes: pngBytes(32) }],
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const media = result.value.media[0];
    expect(media.origin).toBe("user_attachment");
    expect(media.ref).toBe("1.png");

    const mediaPath = path.join(store.getMomentsMediaRootDir(), result.value.id, media.ref);
    expect(fs.existsSync(mediaPath)).toBe(true);
  });

  it("删除动态级联删除评论、点赞与图片副本", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({
      text: "要删的",
      images: [{ name: "a.png", mime: "image/png", bytes: pngBytes() }],
    });
    if (!post.applied) throw new Error("create failed");
    const postId = post.value.id;
    await store.createComment({ postId, content: "评论" }, "user");
    await store.toggleLike(postId, "user");

    const deleted = await store.deletePost(postId);
    expect(deleted.applied).toBe(true);

    const feed = store.listFeed();
    expect(feed).toHaveLength(0);
    expect(fs.existsSync(path.join(store.getMomentsMediaRootDir(), postId))).toBe(false);
  });

  it("删除不存在的动态返回 post_not_found", async () => {
    const store = await freshStore();
    expect(await store.deletePost("moment_missing")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("评论校验：目标动态必须存在、replyTo 必须属于同一动态、内容有上限", async () => {
    const store = await freshStore();
    const postA = await store.createUserPost({ text: "A" });
    const postB = await store.createUserPost({ text: "B" });
    if (!postA.applied || !postB.applied) throw new Error("create failed");

    expect(await store.createComment({ postId: "moment_missing", content: "x" }, "user"))
      .toMatchObject({ applied: false, reason: "post_not_found" });
    expect(await store.createComment({ postId: postA.value.id, content: "x".repeat(501) }, "user"))
      .toMatchObject({ applied: false, reason: "invalid_input" });

    const commentOnB = await store.createComment({ postId: postB.value.id, content: "B 下的评论" }, "cyrene");
    expect(commentOnB.applied).toBe(true);
    if (!commentOnB.applied) return;

    // 跨动态 replyTo：拒绝（过期/错乱的 AI 回复不会落到错误的动态下）
    expect(
      await store.createComment({ postId: postA.value.id, content: "回错地方", replyTo: commentOnB.value.id }, "user"),
    ).toMatchObject({ applied: false, reason: "reply_to_not_found" });

    const reply = await store.createComment(
      { postId: postB.value.id, content: "回复你", replyTo: commentOnB.value.id },
      "user",
    );
    expect(reply.applied).toBe(true);

    const item = store.getFeedItem(postB.value.id);
    expect(item?.comments).toHaveLength(2);
    expect(item?.comments[1].replyTo).toBe(commentOnB.value.id);
  });

  it("点赞唯一性：toggle 只能 insert/remove，不会重复点赞", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "赞我" });
    if (!post.applied) throw new Error("create failed");

    expect(await store.toggleLike(post.value.id, "user")).toMatchObject({ applied: true, value: { liked: true } });
    expect(await store.toggleLike(post.value.id, "user")).toMatchObject({ applied: true, value: { liked: false } });
    expect(await store.toggleLike(post.value.id, "cyrene")).toMatchObject({ applied: true, value: { liked: true } });

    const item = store.getFeedItem(post.value.id);
    expect(item?.likes).toHaveLength(1);
    expect(item?.likes[0].actor).toBe("cyrene");

    expect(await store.toggleLike("moment_missing", "user")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("并发写串行化：删动态后迟到的评论被拒绝，不产生孤儿数据", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "并发目标" });
    if (!post.applied) throw new Error("create failed");

    // 模拟「AI 还在思考时用户删了动态」：删除与迟到评论并发入队
    const [deleted, lateComment, lateLike] = await Promise.all([
      store.deletePost(post.value.id),
      store.createComment({ postId: post.value.id, content: "迟到的评论" }, "cyrene"),
      store.toggleLike(post.value.id, "cyrene"),
    ]);

    expect(deleted.applied).toBe(true);
    expect(lateComment).toMatchObject({ applied: false, reason: "post_not_found" });
    expect(lateLike).toMatchObject({ applied: false, reason: "post_not_found" });
    expect(store.listFeed()).toHaveLength(0);
  });

  it("落盘后可恢复（moments.json 持久化）", async () => {
    const store = await freshStore();
    await store.createUserPost({ title: "持久", text: "重启还在" });

    vi.resetModules();
    const reloaded = await import("./moments-store");
    reloaded.initialize();
    const feed = reloaded.listFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].post.title).toBe("持久");
  });

  it("createCyrenePost 内部通道可发昔涟动态（不携带图片副本逻辑）", async () => {
    const store = await freshStore();
    const result = await store.createCyrenePost({ text: "今天有点想偷懒。" });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.value.author).toBe("cyrene");
    expect(result.value.media).toHaveLength(0);
  });

  it("昔涟点赞只插入不撤销：重复提交被 reaction_exists 拒绝", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "赞我" });
    if (!post.applied) throw new Error("create failed");

    expect(await store.createCyreneLike(post.value.id)).toMatchObject({ applied: true, value: { liked: true } });
    expect(await store.createCyreneLike(post.value.id)).toMatchObject({ applied: false, reason: "reaction_exists" });
    // 用户 toggle 互不影响（唯一性按 actor 区分）
    expect(await store.toggleLike(post.value.id, "user")).toMatchObject({ applied: true, value: { liked: true } });
    expect(await store.createCyreneLike("moment_missing")).toMatchObject({ applied: false, reason: "post_not_found" });
  });

  it("反应开关关闭时昔涟提交被 moments_disabled 拒绝，用户操作不受影响", async () => {
    const store = await freshStore();
    const post = await store.createUserPost({ text: "开关测试" });
    if (!post.applied) throw new Error("create failed");

    store.setCyreneBehaviorGate(() => false);
    expect(await store.createCyreneLike(post.value.id)).toMatchObject({ applied: false, reason: "moments_disabled" });
    expect(await store.createComment({ postId: post.value.id, content: "迟到的 AI 评论" }, "cyrene"))
      .toMatchObject({ applied: false, reason: "moments_disabled" });
    expect(await store.createCyrenePost({ text: "发不出去" })).toMatchObject({ applied: false, reason: "moments_disabled" });
    // 用户侧不经过昔涟门控，照常可用
    expect((await store.createComment({ postId: post.value.id, content: "用户还能评论" }, "user")).applied).toBe(true);
    expect((await store.toggleLike(post.value.id, "user")).applied).toBe(true);
    // 门控按行为种类区分：posting 放行时昔涟发帖不受反应开关影响
    store.setCyreneBehaviorGate((behavior) => behavior === "posting");
    expect((await store.createCyrenePost({ text: "发得出去" })).applied).toBe(true);
  });
});
