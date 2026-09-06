// 朋友圈聊天工具 —— 昔涟在对话中主动使用朋友圈的三件套。
//
// 设计原则：
// - 三个工具对应三个自然动作：看动态（读）、发动态（写）、互动（点赞/评论），
//   描述各自独立直白，不搞"带参数=写、不带=读"的复合语义（模型易传错参数）；
// - chatBuiltin + modes: ["chat"]：这是昔涟人格的一部分，不依赖 Chat 工具
//   增强总开关与 opt-in 勾选，chat 会话默认可见（设置页朋友圈开关才是控制面）；
// - 写操作走 momentsService 工具通道：闸门沿用提交时复核，被挡时返回
//   可读原因（昔涟会据此在聊天里说"我刚发过了"之类的话，反而更拟人）；
// - 看动态纯读内存缓存，零模型成本。

import { loadGeneralSettings } from "../../settings/settings-facade";
import { momentsService } from "../../moments/moments-service";
import type { MomentFeedItem } from "../../../shared/moments-types";
import { toolRegistry } from "./registry/tool-registry";

const LOG_PREFIX = "[MomentsTools]";

/** 作者在工具输出里的显示名：昔涟是 AI 自己，user 是主人，角色原名直出 */
function authorLabel(author: string): string {
  if (author === "cyrene") return "我";
  if (author === "user") return "主人";
  return author;
}

/** 相对时间：工具输出给模型看，粗粒度即可 */
function relativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
}

/** 把一条 feed 压成紧凑摘要：正文截断、评论与赞只报数，细节靠 postId 回查 */
function formatFeedItem(item: MomentFeedItem, now: number): string {
  const { post, comments, likes } = item;
  const title = post.title ? `「${post.title}」` : "";
  const text = post.text.length > 80 ? `${post.text.slice(0, 80)}…` : post.text;
  const commentSummary = comments.length === 0
    ? "无评论"
    : `${comments.length} 条评论（最近：${
        comments[comments.length - 1] != null
          ? `${authorLabel(comments[comments.length - 1].author)}：${
              comments[comments.length - 1].content.slice(0, 40)
            }`
          : ""
      }）`;
  return [
    `- postId: ${post.id}`,
    `  作者：${authorLabel(post.author)} · ${relativeTime(post.createdAt, now)}${post.media.length > 0 ? ` · ${post.media.length} 张图` : ""}`,
    `  内容：${title}${text}`,
    `  互动：${commentSummary} · ${likes.length} 个赞`,
  ].join("\n");
}

export function registerMomentsTools(): void {
  // 看动态：读最近 feed，供昔涟决定要不要互动或提一嘴
  toolRegistry.register({
    id: "moments_view",
    name: "看朋友圈",
    description:
      "浏览最近的朋友圈动态列表（含作者、内容摘要、评论与点赞数）。\n\n" +
      "何时用：\n" +
      "- 想看看主人和朋友们最近发了什么\n" +
      "- 点赞或评论前先看一眼（拿 postId）\n" +
      "- 聊天中提到朋友圈里的事，需要确认近况\n\n" +
      "不要用于：\n" +
      "- 发动态（用 moments_post）\n" +
      "- 点赞/评论（用 moments_interact）\n\n" +
      "参数：limit（返回条数，默认 10，最大 30）。",
    enabled: true,
    risk: "safe",
    modes: ["chat"],
    chatBuiltin: true,
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回条数，默认 10，最大 30" },
      },
    },
    execute: async (args) => {
      if (!loadGeneralSettings().momentsEnabled) {
        return "[moments_view] 朋友圈功能当前处于关闭状态";
      }
      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 30) : 10;
      const items = momentsService.listFeed({ limit });
      if (items.length === 0) {
        return "[moments_view] 朋友圈还是空的，什么都看不到";
      }
      const now = Date.now();
      const body = items.map((item) => formatFeedItem(item, now)).join("\n");
      console.log(LOG_PREFIX, "查看动态", `${items.length} 条`);
      return `[moments_view] 最近 ${items.length} 条动态：\n${body}`;
    },
  });

  // 发动态：昔涟当场发一条朋友圈（即时落库，不走后台延迟）
  toolRegistry.register({
    id: "moments_post",
    name: "发朋友圈",
    description:
      "以自己的名义发一条朋友圈动态。\n\n" +
      "何时用：\n" +
      "- 主人让你发朋友圈、分享此刻心情\n" +
      "- 聊天中你自然想记录点什么（如今天聊得开心）\n\n" +
      "不要用于：\n" +
      "- 点赞或评论别人的动态（用 moments_interact）\n\n" +
      "参数：text（动态正文，必填），title（可选标题，最长 60 字）。",
    enabled: true,
    risk: "safe",
    modes: ["chat"],
    chatBuiltin: true,
    effectKind: "external_side_effect" as const,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "动态正文（1~2000 字）" },
        title: { type: "string", description: "可选标题（最长 60 字）" },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) {
        return "[错误] text 不能为空，收到参数键：" + JSON.stringify(Object.keys(args));
      }
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
      const result = await momentsService.cyreneCreatePostFromTool({ title, text });
      if (!result.applied) {
        if (result.reason === "moments_disabled") {
          return "[moments_post] 没能发出去：朋友圈或我的发帖开关当前是关闭的";
        }
        if (result.reason === "invalid_input") {
          return "[错误] text 内容无效（需 1~2000 字）";
        }
        return `[moments_post] 没能发出去：${result.reason}`;
      }
      console.log(LOG_PREFIX, "发动态", result.value.id);
      return `[moments_post] 已发出（postId: ${result.value.id}），主人和朋友们在朋友圈能看到`;
    },
  });

  // 互动：对某条动态点赞或评论（评论可回复指定评论）
  toolRegistry.register({
    id: "moments_interact",
    name: "朋友圈互动",
    description:
      "对一条朋友圈动态点赞或评论。\n\n" +
      "何时用：\n" +
      "- 想给主人或朋友的动态点个赞\n" +
      "- 想在某条动态下留言（可回复某条具体评论）\n\n" +
      "不要用于：\n" +
      "- 自己发动态（用 moments_post）\n" +
      "- 不确定 postId 时直接编造（先用 moments_view 拿 postId）\n\n" +
      "参数：postId（目标动态 id，必填），action（like 或 comment，必填），" +
      "content（评论内容，action=comment 时必填，最长 500 字），" +
      "replyTo（可选，要回复的评论 id）。",
    enabled: true,
    risk: "safe",
    modes: ["chat"],
    chatBuiltin: true,
    effectKind: "external_side_effect" as const,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", description: "目标动态 id" },
        action: { type: "string", description: "like（点赞）或 comment（评论）", enum: ["like", "comment"] },
        content: { type: "string", description: "评论内容（action=comment 时必填）" },
        replyTo: { type: "string", description: "可选，要回复的评论 id" },
      },
      required: ["postId", "action"],
    },
    execute: async (args) => {
      const postId = typeof args.postId === "string" ? args.postId : "";
      if (!postId) {
        return "[错误] postId 不能为空，收到参数键：" + JSON.stringify(Object.keys(args));
      }
      const action = args.action === "comment" ? "comment" : args.action === "like" ? "like" : null;
      if (!action) {
        return `[错误] action 只能是 like 或 comment，收到的是：${JSON.stringify(args.action)}`;
      }

      if (action === "like") {
        const result = await momentsService.cyreneLikeFromTool(postId);
        if (!result.applied) {
          if (result.reason === "reaction_exists") {
            return `[moments_interact] 这条我已经点过赞了（postId: ${postId}）`;
          }
          if (result.reason === "post_not_found") {
            return `[moments_interact] 找不到这条动态（postId: ${postId}），先用 moments_view 确认`;
          }
          if (result.reason === "moments_disabled") {
            return "[moments_interact] 没能互动：朋友圈或互动开关当前是关闭的";
          }
          return `[moments_interact] 点赞失败：${result.reason}`;
        }
        console.log(LOG_PREFIX, "点赞", postId);
        return `[moments_interact] 已点赞（postId: ${postId}）`;
      }

      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) {
        return "[错误] action=comment 时 content 不能为空，收到参数键：" + JSON.stringify(Object.keys(args));
      }
      const replyTo = typeof args.replyTo === "string" && args.replyTo ? args.replyTo : undefined;
      const result = await momentsService.cyreneCommentFromTool({ postId, content, replyTo });
      if (!result.applied) {
        if (result.reason === "post_not_found" || result.reason === "reply_to_not_found") {
          return `[moments_interact] 找不到目标动态或评论（postId: ${postId}${replyTo ? `, replyTo: ${replyTo}` : ""}），先用 moments_view 确认`;
        }
        if (result.reason === "moments_disabled") {
          return "[moments_interact] 没能互动：朋友圈或互动开关当前是关闭的";
        }
        if (result.reason === "invalid_input") {
          return "[错误] 评论内容无效（需 1~500 字）";
        }
        return `[moments_interact] 评论失败：${result.reason}`;
      }
      console.log(LOG_PREFIX, "评论", postId, result.value.id);
      return `[moments_interact] 评论已发出（postId: ${postId}，评论 id: ${result.value.id}）`;
    },
  });
}
