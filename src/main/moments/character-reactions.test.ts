// character-reactions 单测：抽签分布边界、加权不放回抽取、双骰分流三路、
// 回复落点深度的评论树穷举，以及 10 万条动态的大样本模拟
// （冷场率、候选数分布、高活跃入选率、平均表态/点赞次数——调参的统计准绳）。
import { describe, expect, it } from "vitest";
import type { MomentComment, MomentPost } from "../../shared/moments-types";
import type { CharacterPersona } from "./character-personas";
import {
  MAX_AI_REPLY_LANDING_DEPTH,
  computeReplyLandingDepth,
  pickCandidateCount,
  pickWeightedCandidates,
  rollReactionDice,
  withinReplyDepthLimit,
} from "./character-reactions";

function makePersona(overrides: Partial<CharacterPersona> = {}): CharacterPersona {
  return {
    nickname: "万敌",
    assetFileName: "万敌.png",
    personaText: "角色卡",
    headerText: "注入头",
    activityWeight: 0.35,
    commentDice: 0.22,
    likeDice: 0.4,
    ...overrides,
  };
}

/** 顺序消费的随机源：按传入序列依次返回，耗尽后恒返回最后一个值 */
function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => (index < values.length ? values[index++] : values[values.length - 1]);
}

let nextCommentSeq = 0;
function makeComment(overrides: Partial<MomentComment> = {}): MomentComment {
  nextCommentSeq += 1;
  return {
    id: `c${nextCommentSeq}`,
    postId: "moment_p1",
    author: "user",
    content: "评论",
    createdAt: nextCommentSeq * 1_000,
    ...overrides,
  };
}

// ── 抽签 ────────────────────────────────────────────────────────

describe("pickCandidateCount 冷场分布", () => {
  it("按累计概率落桶：边界值映射到 0/1/2/3 人", () => {
    expect(pickCandidateCount(() => 0.05)).toBe(0); // 一成冷场
    expect(pickCandidateCount(() => 0.15)).toBe(1);
    expect(pickCandidateCount(() => 0.5)).toBe(2);
    expect(pickCandidateCount(() => 0.9)).toBe(3);
    expect(pickCandidateCount(() => 0.999)).toBe(3);
  });
});

describe("pickWeightedCandidates 加权不放回抽取", () => {
  it("权重高者按概率优先，权重低者在随机落点时被抽中", () => {
    const heavy = makePersona({ nickname: "风堇", activityWeight: 0.75 });
    const light = makePersona({ nickname: "遐蝶", activityWeight: 0.05 });
    // roll 落在风堇的权重区间内 → 抽中风堇
    expect(pickWeightedCandidates([heavy, light], 1, () => 0.5)).toEqual([heavy]);
    // roll 越过风堇区间（≥ (0.75+0.05)*0.99 的比例位）→ 抽中遐蝶
    expect(pickWeightedCandidates([heavy, light], 1, () => 0.99)).toEqual([light]);
  });

  it("不放回：同一轮不会重复抽中同一人", () => {
    const personas = [
      makePersona({ nickname: "甲", activityWeight: 0.75 }),
      makePersona({ nickname: "乙", activityWeight: 0.5 }),
    ];
    for (const roll of [0.01, 0.4, 0.7, 0.99]) {
      const picked = pickWeightedCandidates(personas, 2, () => roll);
      expect(picked).toHaveLength(2);
      expect(new Set(picked.map((persona) => persona.nickname)).size).toBe(2);
    }
  });

  it("抽取数超过池子大小时饱和：返回全部且不报错", () => {
    const personas = [makePersona({ nickname: "甲" }), makePersona({ nickname: "乙" })];
    expect(pickWeightedCandidates(personas, 5, () => 0.5)).toHaveLength(2);
  });
});

describe("rollReactionDice 双骰分流", () => {
  it("评论骰掷中 → 走模型表态", () => {
    const persona = makePersona({ commentDice: 0.5, likeDice: 0.4 });
    expect(rollReactionDice(persona, sequenceRandom([0.49]))).toBe("post_eval");
  });

  it("评论骰未中、点赞骰掷中 → 随机点赞", () => {
    const persona = makePersona({ commentDice: 0.5, likeDice: 0.4 });
    expect(rollReactionDice(persona, sequenceRandom([0.6, 0.3]))).toBe("auto_like");
  });

  it("两骰都未中 → 刷到但划走", () => {
    const persona = makePersona({ commentDice: 0.5, likeDice: 0.4 });
    expect(rollReactionDice(persona, sequenceRandom([0.6, 0.5]))).toBe("silent");
  });
});

// ── 回复落点深度 ────────────────────────────────────────────────

describe("computeReplyLandingDepth 评论树穷举", () => {
  it("昔涟动态：角色评(0) → 昔涟回(1) → 角色再回(2)，第三跳落点 3 收束", () => {
    const comments = [
      makeComment({ id: "c1", author: "万敌" }),
      makeComment({ id: "c2", author: "cyrene", replyTo: "c1" }),
      makeComment({ id: "c3", author: "万敌", replyTo: "c2" }),
    ];
    expect(computeReplyLandingDepth(comments, "c1")).toBe(1);
    expect(computeReplyLandingDepth(comments, "c2")).toBe(2);
    // 回复 c3 会落在第 3 层：达到上限，不入队
    expect(computeReplyLandingDepth(comments, "c3")).toBe(MAX_AI_REPLY_LANDING_DEPTH);
    expect(withinReplyDepthLimit(comments, "c3")).toBe(false);
    expect(withinReplyDepthLimit(comments, "c2")).toBe(true);
  });

  it("用户插话开启新链：回复用户评论从 1 起算，用户之上更早的链不计入", () => {
    const comments = [
      makeComment({ id: "c1", author: "万敌" }),
      makeComment({ id: "c2", author: "user", replyTo: "c1" }),
      makeComment({ id: "c3", author: "万敌", replyTo: "c2" }),
      // 用户在 c3 下再插话，又开新链
      makeComment({ id: "c4", author: "user", replyTo: "c3" }),
    ];
    // 用户评论本身是锚点：AI 回复它固定落在第 1 层
    expect(computeReplyLandingDepth(comments, "c2")).toBe(1);
    expect(computeReplyLandingDepth(comments, "c4")).toBe(1);
    // 回复 c3（角色对用户的回复）落在第 2 层，仍允许
    expect(computeReplyLandingDepth(comments, "c3")).toBe(2);
  });

  it("用户↔角色多轮永不被断：每次用户发言后角色的回复都从新链起算", () => {
    const comments = [
      makeComment({ id: "c1", author: "万敌" }),
      makeComment({ id: "c2", author: "user", replyTo: "c1" }),
      makeComment({ id: "c3", author: "万敌", replyTo: "c2" }),
      makeComment({ id: "c4", author: "user", replyTo: "c3" }),
      makeComment({ id: "c5", author: "万敌", replyTo: "c4" }),
    ];
    for (const userAnchor of ["c2", "c4"]) {
      expect(withinReplyDepthLimit(comments, userAnchor)).toBe(true);
    }
  });

  it("顶层评论的回复落在第 1 层；不存在的触发评论返回 0", () => {
    const comments = [makeComment({ id: "c1", author: "万敌" })];
    expect(computeReplyLandingDepth(comments, "c1")).toBe(1);
    expect(computeReplyLandingDepth(comments, "c_missing")).toBe(0);
  });

  it("replyTo 成环时安全止步，不死循环", () => {
    const comments = [
      makeComment({ id: "c1", author: "万敌", replyTo: "c2" }),
      makeComment({ id: "c2", author: "cyrene", replyTo: "c1" }),
    ];
    expect(computeReplyLandingDepth(comments, "c1")).toBeGreaterThanOrEqual(1);
    expect(computeReplyLandingDepth(comments, "c1")).toBeLessThan(10);
  });
});

// ── 大样本模拟 ──────────────────────────────────────────────────

describe("抽签 + 双骰大样本模拟（10 万条动态）", () => {
  /** 12 位角色覆盖全部档位：1 高 / 2 中高 / 3 中 / 3 中低 / 2 低 / 1 极低 */
  const levelTable = [
    { word: "高", weight: 0.75, comment: 0.5, like: 0.75, count: 1 },
    { word: "中高", weight: 0.5, comment: 0.35, like: 0.55, count: 2 },
    { word: "中", weight: 0.35, comment: 0.22, like: 0.4, count: 3 },
    { word: "中低", weight: 0.22, comment: 0.12, like: 0.25, count: 3 },
    { word: "低", weight: 0.12, comment: 0.06, like: 0.12, count: 2 },
    { word: "极低", weight: 0.05, comment: 0.03, like: 0.05, count: 1 },
  ];
  const personas: CharacterPersona[] = levelTable.flatMap((level) =>
    Array.from({ length: level.count }, (_, i) => makePersona({
      nickname: `${level.word}${i + 1}`,
      activityWeight: level.weight,
      commentDice: level.comment,
      likeDice: level.like,
    })),
  );

  it("冷场率约一成、候选数分布接近 20/45/25、高活跃入选率显著高于极低", () => {
    const totalPosts = 100_000;
    const countDist = [0, 0, 0, 0];
    const pickCounts = new Map<string, number>();
    let postEvals = 0;
    let autoLikes = 0;

    for (let i = 0; i < totalPosts; i++) {
      const candidateCount = pickCandidateCount(Math.random);
      countDist[candidateCount]++;
      if (candidateCount === 0) continue;
      for (const persona of pickWeightedCandidates(personas, candidateCount, Math.random)) {
        pickCounts.set(persona.nickname, (pickCounts.get(persona.nickname) ?? 0) + 1);
        const outcome = rollReactionDice(persona, Math.random);
        if (outcome === "post_eval") postEvals++;
        else if (outcome === "auto_like") autoLikes++;
      }
    }

    // 冷场率 ≈ 10%
    expect(countDist[0] / totalPosts).toBeGreaterThan(0.095);
    expect(countDist[0] / totalPosts).toBeLessThan(0.105);
    // 候选数分布 ≈ 20% / 45% / 25%
    expect(countDist[1] / totalPosts).toBeGreaterThan(0.19);
    expect(countDist[1] / totalPosts).toBeLessThan(0.21);
    expect(countDist[2] / totalPosts).toBeGreaterThan(0.44);
    expect(countDist[2] / totalPosts).toBeLessThan(0.46);
    expect(countDist[3] / totalPosts).toBeGreaterThan(0.24);
    expect(countDist[3] / totalPosts).toBeLessThan(0.26);

    // 高活跃角色真实入选率显著高于极低（权重 0.75 vs 0.05）
    const highPicks = pickCounts.get("高1") ?? 0;
    const veryLowPicks = pickCounts.get("极低1") ?? 0;
    expect(highPicks).toBeGreaterThan(veryLowPicks * 4);

    // 每动态平均模型调用量与随机点赞量（调参参考值）：期望候选 ≈ 1.85 人/动态，
    // 乘上双骰概率后 post_eval 落在四成上下（设计预期"小几十次百分比量级"）
    const avgPostEval = postEvals / totalPosts;
    const avgAutoLike = autoLikes / totalPosts;
    expect(avgPostEval).toBeGreaterThan(0.3);
    expect(avgPostEval).toBeLessThan(0.6);
    expect(avgAutoLike).toBeGreaterThan(0.4);
    expect(avgAutoLike).toBeLessThan(0.7);
    // eslint-disable-next-line no-console -- 模拟统计值是调参的准绳，输出供人查阅
    console.log(
      `[character-reactions 模拟] 平均 post_eval/动态=${avgPostEval.toFixed(3)}, ` +
      `平均 auto_like/动态=${avgAutoLike.toFixed(3)}, ` +
      `高活跃入选率=${(highPicks / totalPosts).toFixed(3)}, ` +
      `极低入选率=${(veryLowPicks / totalPosts).toFixed(3)}`,
    );
  });
});
