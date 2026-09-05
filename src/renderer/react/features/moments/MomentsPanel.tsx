import { useCallback, useEffect, useState } from "react";
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
import momentsIconUrl from "../../assets/moments.png?url";
import "./MomentsPanel.css";

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
