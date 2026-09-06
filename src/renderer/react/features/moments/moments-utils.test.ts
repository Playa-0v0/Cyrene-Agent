import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countUnreadMomentNotices,
  deriveMomentNotices,
  formatMomentTime,
  getMomentsLastReadAt,
  subscribeMomentsWaterMark,
  touchMomentsLastReadAt,
} from "./moments-utils";
import type { MomentAuthor, MomentFeedItem } from "../../../../shared/moments-types";

// 固定参照时间：2026-09-04（周五）22:41:30 本地时间
const NOW = new Date(2026, 8, 4, 22, 41, 30).getTime();

describe("formatMomentTime", () => {
  it("一分钟内显示刚刚", () => {
    expect(formatMomentTime(NOW - 30_000, NOW)).toBe("刚刚");
    expect(formatMomentTime(NOW + 5_000, NOW)).toBe("刚刚"); // 未来时间容错
  });

  it("一小时内显示 n 分钟前", () => {
    expect(formatMomentTime(NOW - 3 * 60_000, NOW)).toBe("3 分钟前");
    expect(formatMomentTime(NOW - 59 * 60_000, NOW)).toBe("59 分钟前");
  });

  it("当天显示 HH:mm", () => {
    const morning = new Date(2026, 8, 4, 9, 5).getTime();
    expect(formatMomentTime(morning, NOW)).toBe("09:05");
  });

  it("昨天显示 昨天 HH:mm", () => {
    const yesterday = new Date(2026, 8, 3, 23, 59).getTime();
    expect(formatMomentTime(yesterday, NOW)).toBe("昨天 23:59");
  });

  it("同年更早显示 M月D日 HH:mm", () => {
    const earlier = new Date(2026, 0, 2, 8, 0).getTime();
    expect(formatMomentTime(earlier, NOW)).toBe("1月2日 08:00");
  });

  it("跨年显示完整日期", () => {
    const lastYear = new Date(2025, 11, 31, 23, 0).getTime();
    expect(formatMomentTime(lastYear, NOW)).toBe("2025年12月31日");
  });
});

// ── 通知派生与已读水位 ─────────────────────────────────────────

interface CommentSeed {
  id: string;
  author: MomentAuthor;
  content?: string;
  replyTo?: string;
  createdAt: number;
}

interface FeedSeed {
  author: MomentAuthor;
  postId: string;
  createdAt?: number;
  comments?: CommentSeed[];
  likes?: Array<{ actor: MomentAuthor; createdAt: number }>;
}

function makeFeedItem(seed: FeedSeed): MomentFeedItem {
  return {
    post: {
      id: seed.postId,
      author: seed.author,
      text: `${seed.postId} 正文`,
      media: [],
      createdAt: seed.createdAt ?? NOW - 3600_000,
    },
    comments: (seed.comments ?? []).map((comment) => ({
      id: comment.id,
      postId: seed.postId,
      author: comment.author,
      content: comment.content ?? `${comment.id} 内容`,
      replyTo: comment.replyTo,
      createdAt: comment.createdAt,
    })),
    likes: (seed.likes ?? []).map((like) => ({
      postId: seed.postId,
      actor: like.actor,
      type: "like" as const,
      createdAt: like.createdAt,
    })),
  };
}

describe("deriveMomentNotices", () => {
  it("用户动态的点赞、顶层评论、对用户评论的回复各产生一条通知", () => {
    const item = makeFeedItem({
      author: "user",
      postId: "p1",
      comments: [
        // 用户自己的评论：不通知
        { id: "c1", author: "user", createdAt: NOW - 40_000 },
        // 万敌的顶级评论：comment 通知
        { id: "c2", author: "万敌", createdAt: NOW - 30_000 },
        // 昔回复用户的评论：reply 通知
        { id: "c3", author: "cyrene", replyTo: "c1", createdAt: NOW - 20_000 },
      ],
      likes: [{ actor: "长夜月", createdAt: NOW - 10_000 }],
    });

    const notices = deriveMomentNotices([item]);
    // 最新互动排最前：点赞（-10s）> 昔回复（-20s）> 万敌评论（-30s）
    expect(notices.map((notice) => notice.kind)).toEqual(["like", "reply", "comment"]);
    expect(notices[0]).toMatchObject({ actor: "长夜月", postId: "p1" });
    expect(notices[1]).toMatchObject({ actor: "cyrene", postId: "p1", commentId: "c3" });
    expect(notices[1].excerpt).toContain("c3 内容");
    expect(notices[2]).toMatchObject({ actor: "万敌", postId: "p1", commentId: "c2" });
  });

  it("角色动态下别人回复用户的评论也算通知（发帖人是谁不重要，回复目标是用户才通知）", () => {
    const item = makeFeedItem({
      author: "cyrene",
      postId: "p1",
      comments: [
        { id: "c1", author: "user", createdAt: NOW - 40_000 },
        { id: "c2", author: "万敌", replyTo: "c1", createdAt: NOW - 30_000 },
        { id: "c3", author: "长夜月", createdAt: NOW - 20_000 },
      ],
      likes: [{ actor: "万敌", createdAt: NOW - 10_000 }],
    });

    const notices = deriveMomentNotices([item]);
    // 昔涟动态下只有"回复用户评论"与用户相关：点赞、角色顶层评论都是 NPC 间后台互动
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "reply", actor: "万敌", commentId: "c2", postId: "p1" });
  });

  it("用户自己的点赞和评论、角色回复角色、悬空回复目标都不产生通知", () => {
    const item = makeFeedItem({
      author: "user",
      postId: "p1",
      comments: [
        // 用户自己的顶级评论：不通知
        { id: "c1", author: "user", createdAt: NOW - 50_000 },
        // 角色回复用户的评论：通知
        { id: "c2", author: "万敌", replyTo: "c1", createdAt: NOW - 40_000 },
        // 角色回复角色：不通知
        { id: "c3", author: "长夜月", replyTo: "c2", createdAt: NOW - 30_000 },
        // 回复目标不存在（目标评论被删后遗留）：不通知
        { id: "c4", author: "万敌", replyTo: "ghost", createdAt: NOW - 20_000 },
      ],
      likes: [
        // 自己赞自己：不通知
        { actor: "user", createdAt: NOW - 10_000 },
      ],
    });

    const notices = deriveMomentNotices([item]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "reply", actor: "万敌", commentId: "c2" });
  });

  it("多条动态合并派生并按时间倒序排列", () => {
    const items = [
      makeFeedItem({ author: "user", postId: "p1", likes: [{ actor: "万敌", createdAt: NOW - 1000 }] }),
      makeFeedItem({ author: "user", postId: "p2", likes: [{ actor: "长夜月", createdAt: NOW - 2000 }] }),
    ];

    const notices = deriveMomentNotices(items);
    expect(notices.map((notice) => notice.postId)).toEqual(["p1", "p2"]);
  });
});

describe("countUnreadMomentNotices", () => {
  const notices = deriveMomentNotices([
    makeFeedItem({
      author: "user",
      postId: "p1",
      likes: [
        { actor: "万敌", createdAt: 1000 },
        { actor: "长夜月", createdAt: 2000 },
      ],
    }),
  ]);

  it("只统计水位之后的互动", () => {
    expect(countUnreadMomentNotices(notices, 1500)).toBe(1);
    expect(countUnreadMomentNotices(notices, 0)).toBe(2);
    // 水位推进到最新一条之后即全部已读
    expect(countUnreadMomentNotices(notices, 2000)).toBe(0);
  });

  it("未读数封顶 99（徽标显示 99+）", () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      kind: "like" as const,
      actor: `角色${index}`,
      postId: "p1",
      createdAt: index + 1,
    }));
    expect(countUnreadMomentNotices(many, 0)).toBe(99);
  });
});

describe("已读水位", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMemoryStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  }

  it("touch 推进水位并广播订阅者，只进不退", () => {
    stubMemoryStorage();
    expect(getMomentsLastReadAt()).toBe(0);

    const broadcasts: number[] = [];
    const unsubscribe = subscribeMomentsWaterMark(() => broadcasts.push(getMomentsLastReadAt()));

    touchMomentsLastReadAt(1000);
    expect(getMomentsLastReadAt()).toBe(1000);
    expect(broadcasts).toEqual([1000]);

    // 旧时间不覆盖也不广播
    touchMomentsLastReadAt(500);
    expect(getMomentsLastReadAt()).toBe(1000);
    expect(broadcasts).toEqual([1000]);

    // 新时间正常推进
    touchMomentsLastReadAt(2000);
    expect(getMomentsLastReadAt()).toBe(2000);
    expect(broadcasts).toEqual([1000, 2000]);

    unsubscribe();
    touchMomentsLastReadAt(3000);
    expect(broadcasts).toEqual([1000, 2000]);
  });

  it("localStorage 不可用时静默降级：读取视作未读，写入仅广播不持久化", () => {
    // node 测试环境本身没有 localStorage，直接验证降级路径
    expect(getMomentsLastReadAt()).toBe(0);

    let broadcastCount = 0;
    const unsubscribe = subscribeMomentsWaterMark(() => broadcastCount++);
    expect(() => touchMomentsLastReadAt(1000)).not.toThrow();
    expect(broadcastCount).toBe(1);
    // 存储不可用所以读回仍是 0（下次读取徽标会归零）
    expect(getMomentsLastReadAt()).toBe(0);
    unsubscribe();
  });

  it("损坏的水位数据视作从未读过", () => {
    stubMemoryStorage();
    localStorage.setItem("moments.lastReadAt", "not-a-number");
    expect(getMomentsLastReadAt()).toBe(0);
  });
});
