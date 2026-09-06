// Moments（动态 / 朋友圈）领域与 IPC 共享类型。
//
// - 与 src/main/social-context/（对话关系背景，SocialAtom）完全无关，勿混淆；
// - 持久化为 userData/moments.json + userData/moments-media/<postId>/（JSON + schemaVersion）；
// - author 为开放 string：除 user / cyrene 外，其余值表示入驻朋友圈的角色（如 "万敌"），
//   合法性由主进程角色注册表判定，类型层不做穷尽。

export type MomentAuthor = "user" | "cyrene" | (string & {});

/** 判别 author 是否为注册表内的角色（昔涟不算角色）。 */
export function isCharacterAuthor(author: string, knownCharacters: ReadonlySet<string>): boolean {
  return author !== "user" && author !== "cyrene" && knownCharacters.has(author);
}

/** 判别 author 是否为任意 AI 主体（昔涟或角色）。 */
export function isAiAuthor(author: string, knownCharacters: ReadonlySet<string>): boolean {
  return author === "cyrene" || isCharacterAuthor(author, knownCharacters);
}

export interface MomentMedia {
  id: string;
  type: "image";
  /** 贴图 embedding 匹配命中后固化媒体引用（复用贴图素材作配图）。 */
  origin: "user_attachment" | "character_asset";
  /**
   * user_attachment 时为副本文件名（如 "1.jpg"）；
   * character_asset 时为渲染端可直接消费的引用——内置贴图存 public 相对路径
   * （如 "stickers/peek.gif"，渲染端 resolveAsset 解析），用户贴图存 local-sticker:// 完整 URL。
   */
  ref: string;
}

/** 触发快照固化在 Post 上：Chat 指代回查不依赖原会话当前状态（D11）。 */
export interface MomentPostSource {
  type: "manual" | "conversation";
  triggerConversationId?: string;
  triggerRunId?: string;
  triggerExcerpt?: string;
}

export interface MomentPost {
  id: string;
  author: MomentAuthor;
  /** QQ 空间式标题，可选 */
  title?: string;
  text: string;
  media: MomentMedia[];
  createdAt: number;
  updatedAt?: number;
  source?: MomentPostSource;
}

export interface MomentComment {
  id: string;
  postId: string;
  author: MomentAuthor;
  content: string;
  /** 回复目标评论 id；顶级评论缺省 */
  replyTo?: string;
  createdAt: number;
  /**
   * 产生本评论的反应任务 id（AI 评论幂等键）：同一任务崩溃重跑时
   * 凭此字段识别"评论已落库"，不重复写入。用户评论不带此字段。
   */
  sourceTaskId?: string;
}

/** V1 仅 like。不变量 I1：(postId, actor, type) 全局唯一。 */
export interface MomentReaction {
  postId: string;
  actor: MomentAuthor;
  type: "like";
  createdAt: number;
}

export interface MomentsStoreData {
  schemaVersion: 2;
  posts: MomentPost[];
  comments: MomentComment[];
  reactions: MomentReaction[];
}

// ── 限制（主进程强制；渲染层只做提示，不作安全依据） ──────────────
export const MOMENT_MAX_POST_TEXT_LENGTH = 2000;
export const MOMENT_MAX_POST_TITLE_LENGTH = 60;
export const MOMENT_MAX_COMMENT_TEXT_LENGTH = 500;
export const MOMENT_MAX_IMAGES_PER_POST = 9;
export const MOMENT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MOMENT_ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

// ── 角色朋友圈记忆（timeline） ─────────────────────────────────
// 按角色精确查询的跨动态互动记录，供反应 prompt 注入"她/他最近在朋友圈做了什么"。

/** 角色自己的评论条目（附他人对该评论的回复，保留对话连续性）。 */
export interface CharacterTimelineCommentEntry {
  kind: "comment";
  post: MomentPost;
  comment: MomentComment;
  /** 该评论下的直接回复（时间正序） */
  replies: MomentComment[];
}

/** 角色的点赞条目（低信息量，槽位受限）。 */
export interface CharacterTimelineLikeEntry {
  kind: "like";
  post: MomentPost;
  reaction: MomentReaction;
}

export type CharacterTimelineEntry = CharacterTimelineCommentEntry | CharacterTimelineLikeEntry;

export interface CharacterTimeline {
  /** 评论/回复优先占主槽位，防止"最近全在点赞"冲掉有内容的对话 */
  entries: CharacterTimelineEntry[];
  /** 查询窗口内被截断的评论数（超出槽位部分） */
  truncatedComments: number;
}

// ── AI 评论落库结果 ────────────────────────────────────────────

/**
 * 角色评论提交结果：created = 本次落库；already_applied = 同一反应任务
 * 此前已产出评论（崩溃重跑），返回既有评论供调用方继续后续调度。
 * 两种状态都必须触发后续事件（如给昔涟入回复任务），already_applied 不是终点。
 */
export type ApplyCommentResult =
  | { status: "created"; comment: MomentComment }
  | { status: "already_applied"; comment: MomentComment }
  | { status: "rejected"; reason: MomentCommitRejectReason };

// ── IPC DTO ────────────────────────────────────────────────────
export interface MomentFeedItem {
  post: MomentPost;
  comments: MomentComment[];
  likes: MomentReaction[];
}

export interface MomentImageUploadInput {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

/** renderer 只能提交内容字段；author/id/createdAt 由主进程强制生成（不信任 renderer）。 */
export interface MomentCreatePostInput {
  title?: string;
  text: string;
  images?: MomentImageUploadInput[];
}

export interface MomentCreateCommentInput {
  postId: string;
  content: string;
  replyTo?: string;
}

export type MomentCommitRejectReason =
  | "invalid_input"
  | "too_many_images"
  | "image_too_large"
  | "unsupported_mime"
  | "post_not_found"
  | "reply_to_not_found"
  | "reaction_exists"
  | "moments_disabled";

export type MomentCommitResult<T> =
  | { applied: true; value: T }
  | { applied: false; reason: MomentCommitRejectReason };

/** 渲染层直接拼接媒体 URL（主进程协议侧做映射式安全解析，见 moment-media-protocol.ts）。 */
export function buildMomentMediaUrl(postId: string, file: string): string {
  return `moment-media://${encodeURIComponent(postId)}/${encodeURIComponent(file)}`;
}

export interface MomentsApi {
  list: (options?: { limit?: number; before?: number }) => Promise<MomentFeedItem[]>;
  getPost: (postId: string) => Promise<MomentFeedItem | null>;
  createPost: (input: MomentCreatePostInput) => Promise<MomentCommitResult<MomentPost>>;
  deletePost: (postId: string) => Promise<MomentCommitResult<null>>;
  createComment: (input: MomentCreateCommentInput) => Promise<MomentCommitResult<MomentComment>>;
  toggleLike: (postId: string) => Promise<MomentCommitResult<{ liked: boolean }>>;
  onChanged: (callback: () => void) => () => void;
}
