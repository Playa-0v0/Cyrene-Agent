// 朋友圈角色反应调度的纯函数层：抽签（谁刷到）→ 双骰分流（评/赞/划走）
// → 回复链深度闸门（AI 自主接链何时收束）。
//
// 分工原则：随机函数只决定低信息量的事——谁刷到、何时刷到、随手点赞；
// 模型只决定高信息量的事——说什么、回不回。点赞是低信息量动作，
// 不值得一次模型调用；评论是露脸行为，内容错配穿帮度高，必须模型生成。
// 掷骰在入队瞬间一次定型，到期执行时不再重掷——延迟期间世界的任何
// 变化都不改变骰子结果，行为可预测可测试。

import type { MomentComment } from "../../shared/moments-types";
import type { CharacterPersona } from "./character-personas";

// ── 抽签：冷场判定 + 候选人数 ────────────────────────────────────
// 固定候选数（永远 2~3 人）会形成可察觉的模式，时间久了用户能看穿；
// 分布抽签才有"有时热闹有时冷清"的真实感，零反应的冷场是合法结果。

/** 候选人数分布：0 人（冷场）/ 1 人 / 2 人 / 3 人的概率 */
const CANDIDATE_COUNT_WEIGHTS = [0.1, 0.2, 0.45, 0.25] as const;

/** 抽签第一掷：本次动态有几位角色刷到（0 = 无人刷到，动态零反应） */
export function pickCandidateCount(random: () => number): number {
  const total = CANDIDATE_COUNT_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  const roll = random() * total;
  let cumulative = 0;
  for (let count = 0; count < CANDIDATE_COUNT_WEIGHTS.length; count++) {
    cumulative += CANDIDATE_COUNT_WEIGHTS[count];
    if (roll < cumulative) return count;
  }
  return CANDIDATE_COUNT_WEIGHTS.length - 1;
}

/**
 * 按活跃度权重不放回抽取候选：权重高的人更容易"刷到"，
 * 同一条动态不会重复抽中同一人（不放回），低活跃者也有机会出现。
 * activityWeight 是抽签权重而非入选率——真实入选率取决于全体权重与抽取人数。
 */
export function pickWeightedCandidates(
  personas: readonly CharacterPersona[],
  count: number,
  random: () => number,
): CharacterPersona[] {
  const pool = [...personas];
  const picked: CharacterPersona[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, persona) => sum + persona.activityWeight, 0);
    let roll = random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].activityWeight;
      if (roll < 0) {
        index = i;
        break;
      }
    }
    picked.push(pool[index]);
    pool.splice(index, 1);
  }
  return picked;
}

// ── 双骰分流 ────────────────────────────────────────────────────

/** 双骰分流结果：走模型表态 / 随机点赞（不走模型）/ 刷到但划走 */
export type ReactionDiceOutcome = "post_eval" | "auto_like" | "silent";

/**
 * 每位抽中的角色独立掷两颗骰：先掷评论骰（中 → 走模型表态，
 * 模型仍可选沉默/只点赞——"本来想说话，想想只赞好了"是合法路径），
 * 未中再掷点赞骰（中 → 随手点赞，零模型成本），都未中 → 刷到但划走。
 */
export function rollReactionDice(persona: CharacterPersona, random: () => number): ReactionDiceOutcome {
  if (random() < persona.commentDice) return "post_eval";
  if (random() < persona.likeDice) return "auto_like";
  return "silent";
}

// ── 回复链深度 ──────────────────────────────────────────────────
// 限制对象是"AI 自主接龙的深度"，不是总回复数——用户主动维持的交流
// （用户↔角色一来一回）不该被总量断掉，用户任何发言都开启新链。

/** AI 自主接链的落点深度上限：新回复会落在这一层时不再入队，链自然收束 */
export const MAX_AI_REPLY_LANDING_DEPTH = 3;

/**
 * 回复落点深度：如果 AI 此刻回复 triggerCommentId 这条评论，新回复落在第几层。
 * 沿 replyTo 链向上数边：数到顶层评论为止；用户评论是新链锚点——
 * 进入锚点的那条边计入（"AI 回复用户"是第 1 层），锚点之上的边不计入。
 * 触发评论本身就是用户评论时，新回复固定从 1 起算。
 */
export function computeReplyLandingDepth(
  comments: readonly MomentComment[],
  triggerCommentId: string,
): number {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const trigger = byId.get(triggerCommentId);
  if (!trigger) return 0;
  if (trigger.author === "user") return 1;
  let depth = 1; // 边：新回复 → 触发评论
  const seen = new Set<string>();
  let cursor = trigger;
  while (cursor.replyTo && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = byId.get(cursor.replyTo);
    if (!parent) break; // 链上数据残缺：按已数到的深度止步，不猜
    depth += 1; // 边：cursor → parent
    if (parent.author === "user") break; // 用户评论是锚点：其上方的边不计入
    cursor = parent;
  }
  return depth;
}

/** 深度闸门：AI 回复的落点深度达到上限时不入队，链收束等用户插话 */
export function withinReplyDepthLimit(
  comments: readonly MomentComment[],
  triggerCommentId: string,
): boolean {
  return computeReplyLandingDepth(comments, triggerCommentId) < MAX_AI_REPLY_LANDING_DEPTH;
}
