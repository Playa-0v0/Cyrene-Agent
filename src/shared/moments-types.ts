// Moments（动态 / 朋友圈）领域与 IPC 共享类型。
//
// 设计依据：docs/design/2026-09-04-moments-social-feed-design.md
// - 与 src/main/social-context/（对话关系背景，SocialAtom）完全无关，勿混淆；
// - 持久化为 userData/moments.json + userData/moments-media/<postId>/（JSON + schemaVersion）；
// - V1 只做 Post / Comment / Like，不做 AI 驱动（Phase 1）。

export type MomentAuthor = "user" | "cyrene";

export interface MomentMedia {
  id: string;
  type: "image";
  /**
   * user_attachment — 用户发朋友圈时上传，副本存 userData/moments-media/<postId>/，
   *                   生命周期与 post 绑定，删 post 时删副本；
   * character_asset — 配图复用贴图素材（Phase 5）：贴图 embedding 匹配命中后固化媒体引用。
   */
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
}

/** V1 仅 like。不变量 I1：(postId, actor, type) 全局唯一。 */
export interface MomentReaction {
  postId: string;
  actor: MomentAuthor;
  type: "like";
  createdAt: number;
}

export interface MomentsStoreData {
  schemaVersion: 1;
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
