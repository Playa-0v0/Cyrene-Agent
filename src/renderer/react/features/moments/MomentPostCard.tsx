import { CommentOutlined, DeleteOutlined, HeartFilled, HeartOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import {
  MOMENT_MAX_COMMENT_TEXT_LENGTH,
  buildMomentMediaUrl,
  type MomentAuthor,
  type MomentCreateCommentInput,
  type MomentFeedItem,
} from "../../../../shared/moments-types";
import { resolveAsset } from "../../../../shared/renderer-base";
import { useTranslation } from "../../i18n";
import { formatMomentTime } from "./moments-utils";

const CYRENE_AVATAR_URL = resolveAsset("avatars/cyrene-avatar.png");

interface MomentPostCardProps {
  item: MomentFeedItem;
  userAvatarUrl: string | null;
  userDisplayName: string;
  onToggleLike: (postId: string) => void;
  onDelete: (postId: string) => void;
  /** 返回 null 表示成功；返回字符串为错误提示 */
  onComment: (input: MomentCreateCommentInput) => Promise<string | null>;
}

/** 微信朋友圈式动态卡片：头像 + 名字 + 正文 + 九宫格图 + 时间/操作 + 点赞评论。 */
export function MomentPostCard({
  item,
  userAvatarUrl,
  userDisplayName,
  onToggleLike,
  onDelete,
  onComment,
}: MomentPostCardProps) {
  const { t } = useTranslation();
  const { post, comments, likes } = item;
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | undefined>(undefined);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const authorName = (author: MomentAuthor): string =>
    author === "cyrene" ? t("moments.cyreneName") : userDisplayName;

  const likedByUser = likes.some((like) => like.actor === "user");
  const commentsById = useMemo(() => new Map(comments.map((comment) => [comment.id, comment])), [comments]);
  const replyTarget = replyTo ? commentsById.get(replyTo) : undefined;

  const imageClass = post.media.length === 1
    ? "moment-card__images moment-card__images--single"
    : post.media.length === 2 || post.media.length === 4
      ? "moment-card__images moment-card__images--two"
      : "moment-card__images";

  function startReply(commentId?: string) {
    setReplyTo(commentId);
    setCommenting(true);
    setCommentError(null);
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    const failure = await onComment({ postId: post.id, content, replyTo });
    setSending(false);
    if (failure) {
      setCommentError(failure);
      return;
    }
    setDraft("");
    setReplyTo(undefined);
    setCommenting(false);
    setCommentError(null);
  }

  return (
    <article className="moment-card">
      <div className="moment-card__avatar">
        {post.author === "cyrene" ? (
          <img src={CYRENE_AVATAR_URL} alt={t("moments.cyreneName")} draggable={false} />
        ) : userAvatarUrl ? (
          <img src={userAvatarUrl} alt={userDisplayName} draggable={false} />
        ) : (
          <span className="moment-card__avatar-fallback">{userDisplayName.slice(0, 1)}</span>
        )}
      </div>

      <div className="moment-card__body">
        <div className="moment-card__name">{authorName(post.author)}</div>
        {post.title && <div className="moment-card__title">{post.title}</div>}
        {post.text && <div className="moment-card__text">{post.text}</div>}

        {post.media.length > 0 && (
          <div className={imageClass}>
            {post.media.map((media) => (
              <img
                key={media.id}
                src={buildMomentMediaUrl(post.id, media.ref)}
                alt=""
                loading="lazy"
                draggable={false}
              />
            ))}
          </div>
        )}

        <div className="moment-card__meta">
          <span className="moment-card__time">{formatMomentTime(post.createdAt, Date.now())}</span>
          <button
            type="button"
            className="moment-card__delete"
            onClick={() => {
              if (window.confirm(t("moments.confirmDelete"))) onDelete(post.id);
            }}
          >
            <DeleteOutlined />
            {t("moments.delete")}
          </button>
          <div className="moment-card__actions">
            <button
              type="button"
              className={`moment-card__action${likedByUser ? " is-active" : ""}`}
              onClick={() => onToggleLike(post.id)}
            >
              {likedByUser ? <HeartFilled /> : <HeartOutlined />}
              {t("moments.like")}
              {likes.length > 0 && <span className="moment-card__action-count">{likes.length}</span>}
            </button>
            <button
              type="button"
              className="moment-card__action"
              onClick={() => startReply(undefined)}
            >
              <CommentOutlined />
              {t("moments.comment")}
              {comments.length > 0 && <span className="moment-card__action-count">{comments.length}</span>}
            </button>
          </div>
        </div>

        {(likes.length > 0 || comments.length > 0 || commenting) && (
          <div className="moment-card__interactions">
            {likes.length > 0 && (
              <div className="moment-card__likes">
                <HeartFilled className="moment-card__likes-icon" />
                {likes.map((like) => authorName(like.actor)).join("、")}
              </div>
            )}

            {comments.map((comment) => {
              const target = comment.replyTo ? commentsById.get(comment.replyTo) : undefined;
              return (
                <button
                  type="button"
                  key={comment.id}
                  className="moment-card__comment"
                  onClick={() => startReply(comment.id)}
                >
                  <span className="moment-card__comment-name">{authorName(comment.author)}</span>
                  {target && (
                    <>
                      <span className="moment-card__comment-reply">{t("moments.replyPrefix")}</span>
                      <span className="moment-card__comment-name">{authorName(target.author)}</span>
                    </>
                  )}
                  <span className="moment-card__comment-colon">：</span>
                  <span className="moment-card__comment-content">{comment.content}</span>
                </button>
              );
            })}

            {commenting && (
              <div className="moment-card__comment-editor">
                <input
                  autoFocus
                  type="text"
                  value={draft}
                  maxLength={MOMENT_MAX_COMMENT_TEXT_LENGTH}
                  placeholder={
                    replyTarget
                      ? t("moments.replyPlaceholder", { name: authorName(replyTarget.author) })
                      : t("moments.commentPlaceholder")
                  }
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSend();
                    if (event.key === "Escape") setCommenting(false);
                  }}
                />
                <button
                  type="button"
                  className="moment-card__comment-send"
                  disabled={!draft.trim() || sending}
                  onClick={() => void handleSend()}
                >
                  {t("moments.send")}
                </button>
                <button
                  type="button"
                  className="moment-card__comment-cancel"
                  onClick={() => setCommenting(false)}
                >
                  {t("moments.cancel")}
                </button>
              </div>
            )}
            {commentError && <div className="moment-card__comment-error">{commentError}</div>}
          </div>
        )}
      </div>
    </article>
  );
}
