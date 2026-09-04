import { CloseOutlined, PictureOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import {
  MOMENT_ALLOWED_IMAGE_MIME,
  MOMENT_MAX_IMAGE_BYTES,
  MOMENT_MAX_IMAGES_PER_POST,
  MOMENT_MAX_POST_TEXT_LENGTH,
  MOMENT_MAX_POST_TITLE_LENGTH,
  type MomentCreatePostInput,
} from "../../../../shared/moments-types";
import { useTranslation } from "../../i18n";

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface MomentComposerProps {
  submitting: boolean;
  /** 返回 null 表示成功；返回字符串为错误提示 */
  onPublish: (input: MomentCreatePostInput) => Promise<string | null>;
}

/** QQ 空间式常驻发布框：标题（可选）+ 正文 + 图片，点开就能发。 */
export function MomentComposer({ submitting, onPublish }: MomentComposerProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 卸载时回收 objectURL
  useEffect(() => {
    return () => {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = !submitting && (text.trim().length > 0 || images.length > 0);

  function handlePickImages(files: FileList | null) {
    if (!files) return;
    setError(null);
    const next = [...images];
    for (const file of Array.from(files)) {
      if (next.length >= MOMENT_MAX_IMAGES_PER_POST) {
        setError(t("moments.error.too_many_images"));
        break;
      }
      if (!MOMENT_ALLOWED_IMAGE_MIME.includes(file.type as (typeof MOMENT_ALLOWED_IMAGE_MIME)[number])) {
        setError(t("moments.error.unsupported_mime"));
        continue;
      }
      if (file.size <= 0 || file.size > MOMENT_MAX_IMAGE_BYTES) {
        setError(t("moments.error.image_too_large"));
        continue;
      }
      next.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    setImages(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(index: number) {
    setImages((current) => {
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    const payload: MomentCreatePostInput = {
      title: title.trim() || undefined,
      text: text.trim(),
      images: await Promise.all(
        images.map(async (image) => ({
          name: image.file.name,
          mime: image.file.type,
          bytes: await image.file.arrayBuffer(),
        })),
      ),
    };
    const failure = await onPublish(payload);
    if (failure) {
      setError(failure);
      return;
    }
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setTitle("");
    setText("");
    setImages([]);
  }

  return (
    <section className="moments-composer" aria-label={t("moments.title")}>
      <input
        className="moments-composer__title"
        type="text"
        value={title}
        maxLength={MOMENT_MAX_POST_TITLE_LENGTH}
        placeholder={t("moments.composerTitlePlaceholder")}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className="moments-composer__text"
        value={text}
        rows={3}
        maxLength={MOMENT_MAX_POST_TEXT_LENGTH}
        placeholder={t("moments.composerPlaceholder")}
        onChange={(event) => setText(event.target.value)}
      />

      {images.length > 0 && (
        <div className="moments-composer__previews">
          {images.map((image, index) => (
            <div className="moments-composer__preview" key={image.previewUrl}>
              <img src={image.previewUrl} alt={image.file.name} draggable={false} />
              <button
                type="button"
                className="moments-composer__preview-remove"
                aria-label={t("moments.delete")}
                onClick={() => removeImage(index)}
              >
                <CloseOutlined />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="moments-composer__footer">
        <div className="moments-composer__tools">
          <button
            type="button"
            className="moments-composer__tool"
            onClick={() => fileInputRef.current?.click()}
          >
            <PictureOutlined />
            <span>{t("moments.addImages")}</span>
            {images.length > 0 && (
              <span className="moments-composer__count">
                {t("moments.imagesCount", { count: images.length })}
              </span>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => handlePickImages(event.target.files)}
          />
          {error && <span className="moments-composer__error">{error}</span>}
        </div>
        <button
          type="button"
          className="moments-composer__publish"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          {submitting ? t("moments.publishing") : t("moments.publish")}
        </button>
      </div>
    </section>
  );
}
