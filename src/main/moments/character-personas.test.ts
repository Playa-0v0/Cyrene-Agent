// character-personas 单测：frontmatter 解析、注册表交集、注入头提取、
// 时间线格式化、prompt 组装与两套决策解析。
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type {
  CharacterTimeline,
  MomentComment,
  MomentPost,
  MomentReaction,
} from "../../shared/moments-types";
import {
  buildCharacterPostEvalMessages,
  buildCharacterReplyEvalMessages,
  formatCharacterTimeline,
  loadCharacterPersonas,
  parseCharacterPostDecision,
  parseCharacterReplyDecision,
  parsePersonaFrontmatter,
  type CharacterPersona,
} from "./character-personas";
import type { MomentPostImage } from "./moments-agent";

// character-personas 经 external-content-paths 间接引用 electron；
// 测试全部显式传入 promptDirectories，mock 只为让模块加载不炸
const electronMock = vi.hoisted(() => ({ userDataDir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
}));

// ── fixture 辅助 ────────────────────────────────────────────────

/** 造一个 prompts 根目录，内含 moments_personas/<files>；返回值可直接作 promptDirectories */
function writePersonasDir(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-personas-"));
  const dir = path.join(root, "moments_personas");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return root;
}

function ts(iso: string): number {
  return new Date(iso).getTime();
}

function makePost(overrides: Partial<MomentPost> = {}): MomentPost {
  return {
    id: "moment_p1",
    author: "user",
    text: "跑了十公里",
    media: [],
    createdAt: ts("2026-09-06T08:45:00"),
    ...overrides,
  };
}

function makeComment(overrides: Partial<MomentComment> = {}): MomentComment {
  return {
    id: "comment_c1",
    postId: "moment_p1",
    author: "user",
    content: "一条评论",
    createdAt: ts("2026-09-06T09:00:00"),
    ...overrides,
  };
}

function makeReaction(overrides: Partial<MomentReaction> = {}): MomentReaction {
  return {
    postId: "moment_p1",
    actor: "万敌",
    type: "like",
    createdAt: ts("2026-09-06T10:00:00"),
    ...overrides,
  };
}

const BASE_PERSONA: CharacterPersona = {
  nickname: "万敌",
  assetFileName: "万敌.png",
  personaText: "# 万敌角色卡\n\n话极少，不用语气词。",
  headerText: "你正在刷朋友圈，看到了这条动态。你有权沉默。",
  activityWeight: 0.12,
  commentDice: 0.06,
  likeDice: 0.12,
};

// ── frontmatter 解析 ────────────────────────────────────────────

describe("parsePersonaFrontmatter", () => {
  it("解析三个档位键并从正文中剥离 frontmatter", () => {
    const parsed = parsePersonaFrontmatter(`---\nactivity: 高\ncomment: 低\nlike: 中\n---\n\n# 角色卡\n\n正文`);
    expect(parsed.activity).toBe("高");
    expect(parsed.comment).toBe("低");
    expect(parsed.like).toBe("中");
    expect(parsed.personaText).toBe("# 角色卡\n\n正文");
    expect(parsed.invalidKeys).toEqual([]);
  });

  it("档位词写错记入 invalidKeys，键值为 null；未写的键也是 null", () => {
    const parsed = parsePersonaFrontmatter(`---\ncomment: 超高\n---\n正文`);
    expect(parsed.comment).toBeNull();
    expect(parsed.invalidKeys).toEqual(["comment"]);
    expect(parsed.activity).toBeNull();
    expect(parsed.like).toBeNull();
  });

  it("英文别名、大小写、行内 # 注释都能识别", () => {
    const parsed = parsePersonaFrontmatter(`---\ncomment: mid-high # 评论档位\nlike: LOW\n---\n正文`);
    expect(parsed.comment).toBe("中高");
    expect(parsed.like).toBe("低");
  });

  it("frontmatter 里的整行注释与非约定键被忽略", () => {
    const parsed = parsePersonaFrontmatter(`---\n# 说明行\nhobby: 高\ncomment: 中\n---\n正文`);
    expect(parsed.comment).toBe("中");
    expect(parsed.invalidKeys).toEqual([]);
  });

  it("没有 frontmatter 时正文原样保留，档位全空", () => {
    const parsed = parsePersonaFrontmatter("# 角色卡\n\n【行为倾向】\n- 点赞：高");
    expect(parsed.personaText).toBe("# 角色卡\n\n【行为倾向】\n- 点赞：高");
    expect(parsed.activity).toBeNull();
    expect(parsed.comment).toBeNull();
    expect(parsed.like).toBeNull();
  });

  it("正文中段的 --- 不被误认为 frontmatter", () => {
    const parsed = parsePersonaFrontmatter("# 角色卡\n\n---\ncomment: 高\n---\n正文");
    expect(parsed.comment).toBeNull();
    expect(parsed.personaText).toContain("---");
  });

  it("BOM 开头不破坏首行 --- 识别", () => {
    const parsed = parsePersonaFrontmatter(`\uFEFF---\nlike: 高\n---\n正文`);
    expect(parsed.like).toBe("高");
    expect(parsed.personaText).toBe("正文");
  });
});

// ── 注册表加载 ──────────────────────────────────────────────────

describe("loadCharacterPersonas", () => {
  it("注册表 = 立绘池 ∩ 人设文件；档位按 frontmatter 映射，缺 md 的角色跳过", () => {
    const root = writePersonasDir({
      "万敌.md": "---\ncomment: 低\nlike: 低\n---\n# 万敌卡",
      "_header.md": "# 说明\n\n## 注入头\n\n刷朋友圈场景规则。\n\n## 其他段落\n\n不该注入。",
    });
    const logs: Array<[string, unknown]> = [];
    const registry = loadCharacterPersonas({
      promptDirectories: [root],
      log: (event, detail) => logs.push([event, detail]),
    });

    expect(registry.has("万敌")).toBe(true);
    expect(registry.has("风堇")).toBe(false);
    const wandi = registry.get("万敌")!;
    // 点赞/评论都低 → 活跃度推得低
    expect(wandi.activityWeight).toBe(0.12);
    expect(wandi.commentDice).toBe(0.06);
    expect(wandi.likeDice).toBe(0.12);
    expect(wandi.personaText).toBe("# 万敌卡");
    // 注入头只取 "## 注入头" 段落，后续二级标题截断
    expect(wandi.headerText).toBe("刷朋友圈场景规则。");
    expect(logs.some(([event]) => event === "character_persona_missing")).toBe(true);
  });

  it("六档位词映射到三组固定数值", () => {
    const cases: Array<[string, number, number, number]> = [
      ["高", 0.75, 0.5, 0.75],
      ["中高", 0.5, 0.35, 0.55],
      ["中", 0.35, 0.22, 0.4],
      ["中低", 0.22, 0.12, 0.25],
      ["低", 0.12, 0.06, 0.12],
      ["极低", 0.05, 0.03, 0.05],
    ];
    for (const [word, activity, comment, like] of cases) {
      const root = writePersonasDir({
        "风堇.md": `---\nactivity: ${word}\ncomment: ${word}\nlike: ${word}\n---\n# 卡`,
      });
      const persona = loadCharacterPersonas({ promptDirectories: [root] }).get("风堇")!;
      expect(persona.activityWeight).toBe(activity);
      expect(persona.commentDice).toBe(comment);
      expect(persona.likeDice).toBe(like);
    }
  });

  it("activity 未写时取点赞与评论的较高档", () => {
    const root = writePersonasDir({
      "海瑟音.md": "---\ncomment: 中\nlike: 高\n---\n# 卡",
      "万敌.md": "---\ncomment: 低\nlike: 低\n---\n# 卡",
    });
    const registry = loadCharacterPersonas({ promptDirectories: [root] });
    expect(registry.get("海瑟音")!.activityWeight).toBe(0.75);
    expect(registry.get("万敌")!.activityWeight).toBe(0.12);
  });

  it("activity 写错回退中并记日志；comment/like 写错同样回退中", () => {
    const root = writePersonasDir({
      "那刻夏.md": "---\nactivity: 超高\ncomment: 超高\nlike: 低\n---\n# 卡",
    });
    const logs: Array<[string, unknown]> = [];
    const persona = loadCharacterPersonas({
      promptDirectories: [root],
      log: (event, detail) => logs.push([event, detail]),
    }).get("那刻夏")!;
    expect(persona.activityWeight).toBe(0.35);
    expect(persona.commentDice).toBe(0.22);
    expect(persona.likeDice).toBe(0.12);
    expect(logs).toContainEqual([
      "character_persona_level_fallback",
      { nickname: "那刻夏", keys: ["activity", "comment"] },
    ]);
  });

  it("frontmatter 缺失时三参数全部回退中，正文不影响解析", () => {
    const root = writePersonasDir({
      "风堇.md": "# 风堇卡\n\n【行为倾向】\n- 点赞：高——几乎来者不拒\n- 评论：中高，热情",
    });
    const persona = loadCharacterPersonas({ promptDirectories: [root] }).get("风堇")!;
    expect(persona.activityWeight).toBe(0.35);
    expect(persona.commentDice).toBe(0.22);
    expect(persona.likeDice).toBe(0.4);
    expect(persona.personaText).toContain("【行为倾向】");
  });

  it("目录里立绘池之外的角色卡记跳过日志，不入注册表", () => {
    const root = writePersonasDir({
      "万敌.md": "---\ncomment: 低\nlike: 低\n---\n# 卡",
      "昔涟.md": "---\ncomment: 高\nlike: 高\n---\n# 行为卡",
      "_header.md": "## 注入头\n\n规则",
    });
    const logs: Array<[string, unknown]> = [];
    const registry = loadCharacterPersonas({
      promptDirectories: [root],
      log: (event, detail) => logs.push([event, detail]),
    });
    expect(registry.has("昔涟")).toBe(false);
    expect(logs).toContainEqual(["character_persona_skipped_no_asset", { nickname: "昔涟" }]);
  });

  it("没有 _header.md 时 headerText 为空串，角色仍可注册", () => {
    const root = writePersonasDir({ "万敌.md": "---\nlike: 低\n---\n# 卡" });
    const persona = loadCharacterPersonas({ promptDirectories: [root] }).get("万敌")!;
    expect(persona.headerText).toBe("");
  });
});

// ── 时间线格式化 ────────────────────────────────────────────────

describe("formatCharacterTimeline", () => {
  it("评论条目：动态行 + 你评论了 + 他人回复内联；带标题用书名号", () => {
    const timeline: CharacterTimeline = {
      entries: [
        {
          kind: "comment",
          post: makePost({ title: "今晚的炖菜", text: "自己炖的汤", createdAt: ts("2026-09-04T21:03:00") }),
          comment: makeComment({
            author: "万敌",
            content: "火候不错。",
            createdAt: ts("2026-09-04T21:10:00"),
          }),
          replies: [
            makeComment({
              author: "user",
              content: "下周再战",
              createdAt: ts("2026-09-04T21:20:00"),
            }),
          ],
        },
      ],
      truncatedComments: 0,
    };
    expect(formatCharacterTimeline(timeline)).toBe(
      [
        '9月4日 21:10 用户发布《今晚的炖菜》："自己炖的汤"',
        '  你评论了："火候不错。" 用户回复："下周再战"',
      ].join("\n"),
    );
  });

  it("点赞条目：无标题的动态行 + 你点了赞；角色动态用本名", () => {
    const timeline: CharacterTimeline = {
      entries: [
        {
          kind: "like",
          post: makePost({ author: "cyrene", text: "今天的风很舒服呢", createdAt: ts("2026-09-05T10:12:00") }),
          reaction: makeReaction({ createdAt: ts("2026-09-05T10:30:00") }),
        },
      ],
      truncatedComments: 0,
    };
    expect(formatCharacterTimeline(timeline)).toBe(
      [
        '9月5日 10:30 昔涟发布："今天的风很舒服呢"',
        "  你点了赞。",
      ].join("\n"),
    );
  });

  it("动态正文超长时截断到摘要长度；被截断的评论数在末尾标注", () => {
    const longText = "很".repeat(100);
    const timeline: CharacterTimeline = {
      entries: [
        {
          kind: "like",
          post: makePost({ text: longText }),
          reaction: makeReaction(),
        },
      ],
      truncatedComments: 3,
    };
    const text = formatCharacterTimeline(timeline);
    expect(text).toContain(`"${"很".repeat(60)}…"`);
    expect(text).toContain("（还有 3 条更早的评论，记不清了）");
  });

  it("空时间线返回空串", () => {
    expect(formatCharacterTimeline({ entries: [], truncatedComments: 0 })).toBe("");
  });
});

// ── prompt 组装 ─────────────────────────────────────────────────

describe("buildCharacterPostEvalMessages", () => {
  const localNow = new Date("2026-09-06T14:30:00");

  it("system 顺序：身份声明 → 注入头 → 角色卡 → worldbook", () => {
    const messages = buildCharacterPostEvalMessages({
      persona: BASE_PERSONA,
      worldbook: "冥河设定块",
      post: makePost(),
      comments: [],
      localNow,
    });
    expect(messages[0].role).toBe("system");
    const system = messages[0].content as string;
    expect(system.indexOf("你是万敌。")).toBe(0);
    const headerAt = system.indexOf("你正在刷朋友圈");
    const cardAt = system.indexOf("# 万敌角色卡");
    const worldbookAt = system.indexOf("冥河设定块");
    expect(headerAt).toBeGreaterThan(0);
    expect(cardAt).toBeGreaterThan(headerAt);
    expect(worldbookAt).toBeGreaterThan(cardAt);
  });

  it("user 包含记忆段、此刻段与四种动作的 JSON 契约", () => {
    const messages = buildCharacterPostEvalMessages({
      persona: BASE_PERSONA,
      timeline: {
        entries: [
          {
            kind: "like",
            post: makePost(),
            reaction: makeReaction(),
          },
        ],
        truncatedComments: 0,
      },
      post: makePost({ title: "夜跑" }),
      comments: [],
      localNow,
    });
    const user = messages[1].content as string;
    expect(user).toContain("—— 你的朋友圈记忆（最近的互动，更早的可能记不清了）——");
    expect(user).toContain("你点了赞。");
    expect(user).toContain("—— 此刻 ——");
    expect(user).toContain("用户发布了这条动态：");
    expect(user).toContain("标题：夜跑");
    expect(user).toContain("配图：0 张");
    expect(user).toContain("动态下已有的评论：\n暂无");
    expect(user).toContain('{"action":"silent"}');
    expect(user).toContain('{"action":"like"}');
    expect(user).toContain('{"action":"comment","comment":"要留下的评论"}');
    expect(user).toContain('{"action":"like_comment","comment":"要留下的评论"}');
  });

  it("无记忆时占位说明；动态图片转 image_url block 直发", () => {
    const images: MomentPostImage[] = [{ name: "a.png", dataUrl: "data:image/png;base64,xxx" }];
    const messages = buildCharacterPostEvalMessages({
      persona: BASE_PERSONA,
      post: makePost(),
      postImages: images,
      comments: [],
      localNow,
    });
    const user = messages[1].content;
    expect(Array.isArray(user)).toBe(true);
    const blocks = user as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("（你最近没有在朋友圈留下互动）");
    expect(blocks[1].type).toBe("image_url");
    expect(blocks[1].image_url?.url).toBe("data:image/png;base64,xxx");
  });

  it("评论超过 12 条时只留最近 12 条并标注省略；空白评论不注入", () => {
    const comments = Array.from({ length: 15 }, (_, i) =>
      makeComment({ id: `c${i}`, content: i === 5 ? "   " : `评论${i}`, createdAt: ts("2026-09-06T09:00:00") + i * 60000 }),
    );
    const messages = buildCharacterPostEvalMessages({
      persona: BASE_PERSONA,
      post: makePost(),
      comments,
      localNow,
    });
    const user = messages[1].content as string;
    expect(user).toContain("（更早的评论已省略）");
    // 15 条中 1 条空白被过滤 → 14 条可见，留最近 12 条：c0/c1 被截断，c5 空白不注入
    expect(user).not.toContain("[09:00] 用户：评论0");
    expect(user).not.toContain("[09:01] 用户：评论1");
    expect(user).not.toContain("评论5");
    expect(user).toContain("[09:02] 用户：评论2");
    expect(user).toContain("评论14");
    const shown = comments.filter(
      (c) => c.content.trim() && Number(c.content.replace("评论", "")) >= 2,
    );
    expect(shown).toHaveLength(12);
  });

  it("角色评论用本名展示，回复目标带标注", () => {
    const comments = [
      makeComment({ id: "c1", author: "万敌", content: "保持。", createdAt: ts("2026-09-06T09:00:00") }),
      makeComment({ id: "c2", author: "user", content: "下周再战", replyTo: "c1", createdAt: ts("2026-09-06T09:05:00") }),
    ];
    const messages = buildCharacterPostEvalMessages({
      persona: BASE_PERSONA,
      post: makePost(),
      comments,
      localNow,
    });
    const user = messages[1].content as string;
    expect(user).toContain("[09:00] 万敌：保持。");
    expect(user).toContain("[09:05] 用户（回复万敌）：下周再战");
  });
});

describe("buildCharacterReplyEvalMessages", () => {
  const localNow = new Date("2026-09-06T14:30:00");

  function buildChain() {
    // 万敌顶层评论 → 用户回复 → 万敌回复 → 用户再回复（触发评论）
    const c1 = makeComment({ id: "c1", author: "万敌", content: "保持。", createdAt: ts("2026-09-06T09:00:00") });
    const c2 = makeComment({ id: "c2", author: "user", content: "你也跑吗", replyTo: "c1", createdAt: ts("2026-09-06T09:05:00") });
    const c3 = makeComment({ id: "c3", author: "万敌", content: "每天。", replyTo: "c2", createdAt: ts("2026-09-06T09:10:00") });
    const c4 = makeComment({ id: "c4", author: "user", content: "厉害", replyTo: "c3", createdAt: ts("2026-09-06T09:15:00") });
    return { c1, c2, c3, c4 };
  }

  it("显式给出你的原评论与对方回复，并只提供 silent/reply 两种动作", () => {
    const { c1, c2, c3, c4 } = buildChain();
    const messages = buildCharacterReplyEvalMessages({
      persona: BASE_PERSONA,
      post: makePost(),
      comments: [c1, c2, c3, c4],
      replyTargetId: "c4",
      localNow,
    });
    const user = messages[1].content as string;
    expect(user).toContain("对方刚刚回复了你的这条评论：");
    expect(user).toContain('你的评论："每天。"');
    expect(user).toContain('用户回复："厉害"');
    expect(user).toContain('{"action":"silent"}');
    expect(user).toContain('{"action":"reply","comment":"要发布的回复"}');
    expect(user).not.toContain("like_comment");
  });

  it("评论区注入当前链全量 + 最近 6 条其他评论", () => {
    const { c1, c2, c3, c4 } = buildChain();
    const others = Array.from({ length: 8 }, (_, i) =>
      makeComment({ id: `o${i}`, author: "风堇", content: `其他${i}`, createdAt: ts("2026-09-06T10:00:00") + i * 60000 }),
    );
    const messages = buildCharacterReplyEvalMessages({
      persona: BASE_PERSONA,
      post: makePost(),
      comments: [c1, c2, c3, c4, ...others],
      replyTargetId: "c4",
      localNow,
    });
    const user = messages[1].content as string;
    // 链上四条全量注入
    for (const content of ["保持。", "你也跑吗", "每天。", "厉害"]) {
      expect(user).toContain(content);
    }
    // 其他评论只留最近 6 条（其他2~其他7）
    expect(user).not.toContain("其他0");
    expect(user).not.toContain("其他1");
    expect(user).toContain("其他7");
  });

  it("触发评论不可见时降级为占位说明，不猜内容", () => {
    const messages = buildCharacterReplyEvalMessages({
      persona: BASE_PERSONA,
      post: makePost(),
      comments: [],
      replyTargetId: "c_missing",
      localNow,
    });
    const user = messages[1].content as string;
    expect(user).toContain("那条评论现在已经看不到了");
  });
});

// ── 决策解析 ────────────────────────────────────────────────────

describe("parseCharacterPostDecision", () => {
  it("四种合法动作都能解析，comment trim 后生效", () => {
    expect(parseCharacterPostDecision('{"action":"silent"}')).toEqual({ action: "silent" });
    expect(parseCharacterPostDecision('{"action":"like"}')).toEqual({ action: "like" });
    expect(parseCharacterPostDecision('{"action":"comment","comment":" 保持。 "}')).toEqual({ action: "comment", comment: "保持。" });
    expect(parseCharacterPostDecision('{"action":"like_comment","comment":"不错"}')).toEqual({ action: "like_comment", comment: "不错" });
  });

  it("非法 JSON / 非对象 / 未知动作各自给出原因", () => {
    expect(parseCharacterPostDecision("不是json")).toEqual({ action: "invalid", reason: "invalid_json" });
    expect(parseCharacterPostDecision("[1,2]")).toEqual({ action: "invalid", reason: "invalid_shape" });
    expect(parseCharacterPostDecision('{"action":"share"}')).toEqual({ action: "invalid", reason: "invalid_action" });
  });

  it("comment 空串与超长都判非法（宁沉默不乱说话，不自动截断）", () => {
    expect(parseCharacterPostDecision('{"action":"comment","comment":"   "}')).toEqual({ action: "invalid", reason: "empty_comment" });
    expect(parseCharacterPostDecision(`{"action":"comment","comment":"${"字".repeat(501)}"}`)).toEqual({
      action: "invalid",
      reason: "comment_too_long",
    });
  });
});

describe("parseCharacterReplyDecision", () => {
  it("两种合法动作都能解析", () => {
    expect(parseCharacterReplyDecision('{"action":"silent"}')).toEqual({ action: "silent" });
    expect(parseCharacterReplyDecision('{"action":"reply","comment":" 好。 "}')).toEqual({ action: "reply", comment: "好。" });
  });

  it("非法输入与非法 comment 的降级原因", () => {
    expect(parseCharacterReplyDecision("")).toEqual({ action: "invalid", reason: "invalid_json" });
    expect(parseCharacterReplyDecision('{"action":"reply"}')).toEqual({ action: "invalid", reason: "empty_comment" });
    expect(parseCharacterReplyDecision('{"action":"like"}')).toEqual({ action: "invalid", reason: "invalid_action" });
  });
});
