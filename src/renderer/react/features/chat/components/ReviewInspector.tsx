// ReviewDiffContent — Review diff 内容（由 RightInspector 容器承载）。
//
// 职责：只显示被选中那一个文件的 inline diff 视图 + 文件名标题条。
// 文件列表在气泡内的 ReviewPanel 中，用户在那里点哪个文件，这里就显示哪个文件的 diff。
// 外层 aside / tab 栏 / 关闭按钮由 RightInspector 统一提供。

import { useEffect, useState } from "react";
import { useTranslation } from "../../../i18n";
import type { ReviewFileChange, ReviewLine, ReviewSnapshot } from "../../../../../shared/review-types";
import "./ReviewInspector.css";

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const KIND_LABEL_KEYS: Record<ReviewFileChange["kind"], string> = {
  modified: "review.kindModified",
  created: "review.kindCreated",
  deleted: "review.kindDeleted",
  renamed: "review.kindRenamed",
  binary: "review.kindBinary",
  "large-text": "review.kindLargeText",
};

const KIND_CLASS: Record<ReviewFileChange["kind"], string> = {
  modified: "is-modified",
  created: "is-created",
  deleted: "is-deleted",
  renamed: "is-renamed",
  binary: "is-binary",
  "large-text": "is-large",
};

export function ReviewDiffContent({
  runId,
  fileIndex,
}: {
  runId: string;
  fileIndex: number;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      if (cancelled) return;
      try {
        const result = await window.review?.get(runId);
        if (cancelled) return;
        if (result && result.files.length > 0) {
          setSnapshot(result);
          return;
        }
      } catch {
        // 忽略
      }
    };
    void fetchData();
    return () => { cancelled = true; };
  }, [runId]);

  const file = snapshot?.files[fileIndex];

  return (
    <div className="cy-review-diff-content">
      <div className="cy-review-inspector__file-title" title={file?.newPath ?? ""}>
        {file && (
          <span className={`cy-review-inspector__kind ${KIND_CLASS[file.kind]}`}>
            {t(KIND_LABEL_KEYS[file.kind])}
          </span>
        )}
        <span className="cy-review-inspector__title-text">{file?.newPath ?? t("common.loading")}</span>
      </div>
      <div className="cy-review-inspector__body">
        {!file && <div className="cy-review-inspector__loading">{t("common.loading")}</div>}
        {file && <DiffView file={file} />}
      </div>
    </div>
  );
}

function DiffView({ file }: { file: ReviewFileChange }) {
  const { t } = useTranslation();
  if (file.kind === "binary" || file.kind === "large-text") {
    return (
      <div className="cy-review-inspector__meta">
        <div className="cy-review-inspector__meta-info">
          <span className={`cy-review-inspector__kind ${KIND_CLASS[file.kind]}`}>{t(KIND_LABEL_KEYS[file.kind])}</span>
          {file.before && (
            <span className="cy-review-inspector__meta-size">
              {formatSize(file.before.size)}
              {file.after ? ` → ${formatSize(file.after.size)}` : ""}
            </span>
          )}
          {!file.before && file.after && (
            <span className="cy-review-inspector__meta-size">{formatSize(file.after.size)}</span>
          )}
        </div>
        <div className="cy-review-inspector__meta-hint">
          {file.kind === "binary" ? t("review.binaryHint") : t("review.largeTextHint")}
        </div>
      </div>
    );
  }

  if (!file.hunks || file.hunks.length === 0) {
    return (
      <div className="cy-review-inspector__meta">
        <div className="cy-review-inspector__meta-hint">
          {file.kind === "renamed" ? t("review.renamedHint") : t("review.noDiffHint")}
        </div>
      </div>
    );
  }

  return (
    <div className="cy-review-inspector__diff-content">
      <div className="cy-review-inspector__diff-lines">
        {file.hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex} className="cy-review-inspector__hunk">
            <div className="cy-review-inspector__hunk-header">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, lineIndex) => (
              <DiffLine key={lineIndex} line={line} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffLine({ line }: { line: ReviewLine }) {
  const lineClass = line.type === "add" ? "is-add" : line.type === "remove" ? "is-remove" : "is-context";
  const marker = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
  return (
    <div className={`cy-review-inspector__line ${lineClass}`}>
      <span className="cy-review-inspector__line-old">{line.oldLine ?? ""}</span>
      <span className="cy-review-inspector__line-new">{line.newLine ?? ""}</span>
      <span className="cy-review-inspector__line-marker" aria-hidden="true">{marker}</span>
      <span className="cy-review-inspector__line-text">{line.text || " "}</span>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
