import { useCallback, useEffect, useRef, useState } from "react";
import { BellOutlined } from "@ant-design/icons";
import type {
  MomentCreateCommentInput,
  MomentCreatePostInput,
  MomentFeedItem,
} from "../../../../shared/moments-types";
import { useTranslation } from "../../i18n";
import { useUserAvatar } from "../../hooks/useUserAvatar";
import { useUserNickname } from "../../hooks/useUserNickname";
import { MomentComposer } from "./MomentComposer";
import { MomentPostCard } from "./MomentPostCard";
import {
  countUnreadMomentNotices,
  deriveMomentNotices,
  formatMomentTime,
  getMomentsLastReadAt,
  subscribeMomentsWaterMark,
  touchMomentsLastReadAt,
  type MomentNoticeItem,
} from "./moments-utils";
import { getCharacterPortrait } from "../../character-portraits";
import { resolveAsset } from "../../../../shared/renderer-base";
import momentsIconUrl from "../../assets/moments.png?url";
import "./MomentsPanel.css";

/** 高亮闪烁的驻留时长：跳转定位后短暂点亮目标卡片，帮助视线跟上 */
const NOTICE_FLASH_MS = 1600;

/** 「动态」面板：顶部常驻发布框（QQ 空间式）+ 下方朋友圈式信息流。 */
export function MomentsPanel() {
  const { t } = useTranslation();
  const api = window.moments;
  const userAvatarUrl = useUserAvatar();
  const nickname = useUserNickname();
  const userDisplayName = nickname.trim() || t("moments.userFallbackName");

  const [items, setItems] = useState<MomentFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 通知下拉的开关与已读水位：水位是 localStorage 快照，须放在 state 里才触发徽标重渲染
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [lastReadAt, setLastReadAt] = useState(getMomentsLastReadAt());
  const noticeRootRef = useRef<HTMLDivElement>(null);

  const notices = deriveMomentNotices(items);
  const unreadCount = countUnreadMomentNotices(notices, lastReadAt);

  const reload = useCallback(async () => {
    if (!api) {
      setError(t("moments.apiUnavailable"));
      setLoading(false);
      return;
    }
    try {
      setItems(await api.list({ limit: 50 }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void reload();
    const unsubscribe = api?.onChanged(() => {
      void reload();
    });
    return () => {
      unsubscribe?.();
    };
  }, [api, reload]);

  // 已读水位被推进（本面板或导航按钮打开通知都会 touch）时同步本地快照，徽标立即清零
  useEffect(() => subscribeMomentsWaterMark(() => {
    setLastReadAt(getMomentsLastReadAt());
  }), []);

  // 点击下拉区域外部时收起通知列表
  useEffect(() => {
    if (!noticeOpen) return;
    function onDocMouseDown(event: MouseEvent) {
      if (!noticeRootRef.current?.contains(event.target as Node)) setNoticeOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [noticeOpen]);

  /** 打开通知列表即视为已读：水位推进到最新一条通知的时间 */
  function toggleNoticeOpen() {
    if (noticeOpen) {
      setNoticeOpen(false);
      return;
    }
    setNoticeOpen(true);
    if (notices.length > 0) touchMomentsLastReadAt(notices[0].createdAt);
  }

  /** 点击通知：收起下拉并滚动定位到对应动态，带短暂高亮帮助视线跟上 */
  function handleNoticeClick(notice: MomentNoticeItem) {
    setNoticeOpen(false);
    // 有评论锚点优先定位到评论本身，定位不到（动态已删）再尝试卡片
    const target = (notice.commentId
      ? document.getElementById(`moment-comment-${notice.commentId}`)
      : null) ?? document.getElementById(`moment-post-${notice.postId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    const card = target.closest(".moment-card");
    if (!card) return;
    card.classList.add("is-flash");
    window.setTimeout(() => card.classList.remove("is-flash"), NOTICE_FLASH_MS);
  }

  async function handlePublish(input: MomentCreatePostInput): Promise<string | null> {
    if (!api) return t("moments.apiUnavailable");
    setSubmitting(true);
    try {
      const result = await api.createPost(input);
      // 成功后由 moments:changed 广播触发 reload，无需手动刷新
      return result.applied ? null : t(`moments.error.${result.reason}`);
    } catch {
      return t("moments.publishFailed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(postId: string) {
    if (!api) return;
    const result = await api.deletePost(postId);
    if (!result.applied) setError(t(`moments.error.${result.reason}`));
  }

  async function handleToggleLike(postId: string) {
    if (!api) return;
    const result = await api.toggleLike(postId);
    if (!result.applied) setError(t(`moments.error.${result.reason}`));
  }

  async function handleComment(input: MomentCreateCommentInput): Promise<string | null> {
    if (!api) return t("moments.apiUnavailable");
    const result = await api.createComment(input);
    return result.applied ? null : t(`moments.error.${result.reason}`);
  }

  return (
    <div className="moments-panel">
      <div className="moments-panel__scroll">
        <div className="moments-panel__inner">
          <header className="moments-panel__header">
            <img className="moments-panel__heading-icon" src={momentsIconUrl} alt="" />
            <h1 className="moments-panel__title">{t("moments.title")}</h1>
            <span className="moments-panel__subtitle">{t("moments.subtitle")}</span>
            <div className="moments-panel__notice-root" ref={noticeRootRef}>
              <button
                type="button"
                className="moments-panel__notice-bell"
                onClick={toggleNoticeOpen}
                title={t("moments.notice.bellTitle")}
              >
                <BellOutlined />
                {unreadCount > 0 && (
                  <span className="moments-panel__notice-badge">
                    {unreadCount >= 99 ? "99+" : unreadCount}
                  </span>
                )}
              </button>
              {noticeOpen && (
                <div className="moments-notice-popover">
                  <div className="moments-notice-popover__title">{t("moments.notice.title")}</div>
                  {notices.length === 0 ? (
                    <div className="moments-notice-popover__empty">{t("moments.notice.empty")}</div>
                  ) : (
                    <div className="moments-notice-popover__list">
                      {notices.map((notice) => (
                        <NoticeRow key={`${notice.kind}-${notice.actor}-${notice.commentId ?? notice.postId}-${notice.createdAt}`} notice={notice} onClick={handleNoticeClick} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </header>

          <MomentComposer submitting={submitting} onPublish={handlePublish} />

          {error && <div className="moments-panel__error">{error}</div>}

          {!loading && !error && items.length === 0 && (
            <div className="moments-panel__empty">{t("moments.empty")}</div>
          )}

          <div className="moments-panel__feed">
            {items.map((item) => (
              <MomentPostCard
                key={item.post.id}
                item={item}
                userAvatarUrl={userAvatarUrl}
                userDisplayName={userDisplayName}
                onToggleLike={(postId) => void handleToggleLike(postId)}
                onDelete={(postId) => void handleDelete(postId)}
                onComment={handleComment}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const CYRENE_AVATAR_URL = resolveAsset("avatars/cyrene-avatar.png");

const NOTICE_ACTION_KEYS: Record<MomentNoticeItem["kind"], string> = {
  like: "moments.notice.actionLike",
  comment: "moments.notice.actionComment",
  reply: "moments.notice.actionReply",
};

/** 通知行：头像 + 「谁 对你做了什么」 + 内容摘录 + 相对时间，点击跳转到对应动态 */
function NoticeRow({ notice, onClick }: { notice: MomentNoticeItem; onClick: (notice: MomentNoticeItem) => void }) {
  const { t } = useTranslation();
  const isCyrene = notice.actor === "cyrene";
  // 昔涟走专属头像，角色走立绘池，两者都不是（理论不会出现）则无头像
  const portraitUrl = isCyrene ? CYRENE_AVATAR_URL : getCharacterPortrait(notice.actor);
  const displayName = isCyrene ? t("moments.cyreneName") : notice.actor;
  return (
    <button
      type="button"
      className="moments-notice-item"
      onClick={() => onClick(notice)}
    >
      {portraitUrl && <img className="moments-notice-item__avatar" src={portraitUrl} alt="" draggable={false} />}
      <span className="moments-notice-item__main">
        <span className="moments-notice-item__text">
          <span className={`moments-notice-item__name${isCyrene ? " is-cyrene" : ""}`}>{displayName}</span>
          {t(NOTICE_ACTION_KEYS[notice.kind])}
        </span>
        {notice.excerpt && <span className="moments-notice-item__excerpt">{notice.excerpt}</span>}
        <span className="moments-notice-item__time">{formatMomentTime(notice.createdAt, Date.now())}</span>
      </span>
    </button>
  );
}
