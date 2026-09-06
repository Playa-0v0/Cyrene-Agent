import { CloseOutlined, PictureOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  MOMENT_ALLOWED_IMAGE_MIME,
  MOMENT_MAX_IMAGE_BYTES,
  MOMENT_MAX_IMAGES_PER_POST,
  MOMENT_MAX_POST_TEXT_LENGTH,
  MOMENT_MAX_POST_TITLE_LENGTH,
  type MomentCreatePostInput,
} from "../../../../shared/moments-types";
import { useTranslation } from "../../i18n";
import { getCharacterAvatar } from "../../character-avatars";

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface MomentComposerProps {
  submitting: boolean;
  /** 返回 null 表示成功；返回字符串为错误提示 */
  onPublish: (input: MomentCreatePostInput) => Promise<string | null>;
}

/** @ 选择框的会话状态：@ 的起始下标 + 当前过滤词 + 键盘高亮项 */
interface MentionPickerState {
  /** @ 符号在文本中的下标 */
  at: number;
  /** 光标位置（过滤词结束处） */
  caret: number;
  query: string;
  activeIndex: number;
}

/**
 * 从光标处回溯找正在输入的 @ 提及：@ 必须在行首或空白之后（避开邮箱），
 * 且 @ 与光标之间不允许空白（出现空白说明提及词已结束）。
 * 找到返回选择框状态，找不到返回 null。
 */
function detectMentionTyping(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  const prev = at === 0 ? "" : text[at - 1];
  if (prev && !/\s/.test(prev)) return null;
  return { at, query };
}

/** QQ 群式常驻发布框：标题（可选）+ 正文 + 图片 + @ 点名，点开就能发。 */
export function MomentComposer({ submitting, onPublish }: MomentComposerProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 点名名单（昔涟 + 全部角色）与 @ 选择框状态
  const [mentionNames, setMentionNames] = useState<string[]>([]);
  const [picker, setPicker] = useState<MentionPickerState | null>(null);

  useEffect(() => {
    void window.moments?.listCharacters().then((names) => setMentionNames(names)).catch(() => {
      // 名单拉不到只是没有选择框，正文手打 @ 仍然有效（提交时按文本解析）
    });
  }, []);

  // 选择框候选：过滤词为空显示全部，否则按前缀匹配；昔涟排最前
  const candidates = useMemo(() => {
    if (!picker) return [];
    const query = picker.query;
    return mentionNames.filter((name) =>
      name === "cyrene" ? query === "" || t("moments.mention.cyreneOptionLabel").startsWith(query) : name.startsWith(query),
    );
  }, [picker, mentionNames, t]);

  // 候选变化后收敛高亮下标（过滤后列表变短时防止越界）
  useEffect(() => {
    setPicker((current) =>
      current && current.activeIndex >= Math.max(candidates.length, 1)
        ? { ...current, activeIndex: 0 }
        : current,
    );
  }, [candidates.length]);

  // 卸载时回收 objectURL
  useEffect(() => {
    return () => {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = !submitting && (text.trim().length > 0 || images.length > 0);

  function handleTextChange(nextText: string) {
    setText(nextText);
    const caret = textareaRef.current?.selectionStart ?? nextText.length;
    const detected = detectMentionTyping(nextText, caret);
    setPicker(detected ? { at: detected.at, caret, query: detected.query, activeIndex: 0 } : null);
  }

  /** 把 @候选词 替换为完整 @昵称（带尾随空格），光标落在空格后 */
  function pickMention(nickname: string) {
    if (!picker) return;
    const display = nickname === "cyrene" ? t("moments.mention.cyreneOptionLabel") : nickname;
    const next =
      text.slice(0, picker.at) + `@${display} ` + text.slice(Math.min(picker.caret, text.length));
    setText(next);
    setPicker(null);
    const caret = picker.at + display.length + 2;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  function handleTextKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!picker || candidates.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setPicker((current) => current && {
        ...current,
        activeIndex: (current.activeIndex + delta + candidates.length) % candidates.length,
      });
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      // 选择框打开时 Enter/Tab 选中高亮项，不再充当换行
      event.preventDefault();
      pickMention(candidates[picker.activeIndex] ?? candidates[0]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setPicker(null);
    }
  }

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

  /** 提交时按文本解析点名：正文里出现的 @昵称 全部收入名单。
   *  不依赖选择框状态——手打的 @ 同样有效，删掉 @ 文本则点名自动消失。 */
  function deriveMentions(): string[] {
    const names: string[] = [];
    if (text.includes(`@${t("moments.mention.cyreneOptionLabel")}`)) names.push("cyrene");
    for (const name of mentionNames) {
      if (name !== "cyrene" && text.includes(`@${name}`)) names.push(name);
    }
    return [...new Set(names)];
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    const payload: MomentCreatePostInput = {
      title: title.trim() || undefined,
      text: text.trim(),
      mentions: deriveMentions(),
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
    setPicker(null);
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
        ref={textareaRef}
        className="moments-composer__text"
        value={text}
        rows={3}
        maxLength={MOMENT_MAX_POST_TEXT_LENGTH}
        placeholder={t("moments.composerPlaceholder")}
        onChange={(event) => handleTextChange(event.target.value)}
        onKeyDown={handleTextKeyDown}
      />

      {picker && (
        <div className="moments-composer__mention-picker" role="listbox">
          {candidates.length === 0 ? (
            <div className="moments-composer__mention-empty">{t("moments.mention.pickerEmpty")}</div>
          ) : (
            candidates.map((name, index) => {
              const isCyrene = name === "cyrene";
              const display = isCyrene ? t("moments.mention.cyreneOptionLabel") : name;
              const avatar = isCyrene ? null : getCharacterAvatar(name);
              return (
                <button
                  type="button"
                  key={name}
                  role="option"
                  aria-selected={index === picker.activeIndex}
                  className={`moments-composer__mention-option${
                    index === picker.activeIndex ? " is-active" : ""
                  }`}
                  onMouseDown={(event) => {
                    // 阻止 textarea 失焦闪烁，点击即选
                    event.preventDefault();
                    pickMention(name);
                  }}
                  onMouseEnter={() => setPicker((current) => current && { ...current, activeIndex: index })}
                >
                  {avatar && <img className="moments-composer__mention-avatar" src={avatar} alt="" draggable={false} />}
                  <span>{display}</span>
                </button>
              );
            })
          )}
        </div>
      )}

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
