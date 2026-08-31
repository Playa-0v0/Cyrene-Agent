// RunReviewTracker — 不可变 Review 快照的基线捕获层。
//
// 设计要点：
// - pre-mutation baseline（修改前基线）：某文件在本次 Run 里第一次即将被修改前，
//   保存它的原始状态。之后无论再被改多少次，都不更新这份 baseline。
// - write-ahead：先持久化 baseline 到磁盘，再执行 mutation。Electron 崩溃后
//   baseline 不丢，finalizeReview 仍能生成 Review。
// - journal.jsonl 追加写：记录 capture / rename 事件，天然原子（appendFileSync）。
// - 三级文件处理：普通文本存 content + diff；大型文本存 content 但不自动 diff；
//   二进制只存 metadata（size + hash）。
//
// 存储结构：
//   <userData>/cyrene-runs/reviews/<runId>/
//     journal.jsonl              # 事件日志（每行一个 JSON）
//     before/<sha256(absPath)>   # BeforeImage 文件内容（文本类）
//     before/<hash>.absent       # 文件不存在的标记（新建文件的 baseline）
//     before/<hash>.binary       # 二进制文件标记（JSON：{ size, hash }）
//     snapshot.json              # 最终 ReviewSnapshot（finalizeReview 原子写）

import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import { logger, LogTag } from "../../logger";
import { structuredPatch } from "diff";
import type {
  ReviewSnapshot,
  ReviewFileChange,
  ReviewHunk,
  ReviewLine,
  ReviewRunStatus,
  ReviewFileMeta,
} from "../../../shared/review-types";

// ── 常量 ────────────────────────────────────────────────

/** 大型文本阈值：超过此大小不自动 diff，但仍存 content */
const LARGE_TEXT_THRESHOLD = 1 * 1024 * 1024; // 1MB

/** 二进制/超大文件阈值：超过此大小只存 metadata，不读 content */
const BINARY_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB

/** 二进制检测采样大小 */
const BINARY_SAMPLE_SIZE = 8192;

// ── 类型 ────────────────────────────────────────────────

type CapturedFileKind = "text" | "large-text" | "binary";

interface JournalCaptureEvent {
  type: "capture";
  /** 绝对路径（用于 finalizeReview 时读 B） */
  absPath: string;
  /** 展示路径（相对工作区，前端用） */
  displayPath: string;
  /** sha256(absPath)，用作 before/ 文件名 */
  hash: string;
  /** baseline 时文件是否存在 */
  exists: boolean;
  /** 文件类型分级 */
  fileKind: CapturedFileKind;
  /** 文件大小（字节） */
  size: number;
  /** 内容 SHA-256（二进制超大文件为空字符串） */
  contentHash: string;
  /** 捕获时间戳 */
  capturedAt: number;
}

interface JournalRenameEvent {
  type: "rename";
  fromAbsPath: string;
  toAbsPath: string;
  fromDisplayPath: string;
  toDisplayPath: string;
  at: number;
}

export type JournalEvent = JournalCaptureEvent | JournalRenameEvent;

// ── 辅助函数 ────────────────────────────────────────────

function sha256(value: string | Buffer): string {
  if (typeof value === "string") {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 检测文件类型并读取内容。
 * - >5MB：binary（不读 content）
 * - 含 null byte：binary（不存 content）
 * - >1MB 文本：large-text（存 content，finalizeReview 时不自动 diff）
 * - 其他：text（存 content，finalizeReview 时 diff）
 */
function detectFileKind(absPath: string): {
  kind: CapturedFileKind;
  content: Buffer | null;
  size: number;
  contentHash: string;
} {
  const stat = fs.statSync(absPath);
  const size = stat.size;

  if (size > BINARY_SIZE_THRESHOLD) {
    return { kind: "binary", content: null, size, contentHash: "" };
  }

  const content = fs.readFileSync(absPath);

  // 二进制检测：前 8KB 是否包含 null byte（git 的做法）
  const sample = content.subarray(0, BINARY_SAMPLE_SIZE);
  if (sample.includes(0)) {
    return { kind: "binary", content: null, size, contentHash: sha256(content) };
  }

  if (size > LARGE_TEXT_THRESHOLD) {
    return { kind: "large-text", content, size, contentHash: sha256(content) };
  }

  return { kind: "text", content, size, contentHash: sha256(content) };
}

// ── RunReviewTracker ────────────────────────────────────

export class RunReviewTracker {
  private readonly reviewsRoot: string;

  constructor(userDataRoot: string) {
    this.reviewsRoot = path.join(userDataRoot, "cyrene-runs", "reviews");
  }

  /**
   * 第一次修改某文件前调用，保存 baseline（pre-mutation snapshot）。
   *
   * 核心语义：同一 Run 内同一文件只 capture 第一次（惰性快照）。
   * 后续修改不更新 baseline，确保 Review 反映的是"第一次修改前 → 最终状态"。
   *
   * 必须在 mutation 之前调用（write-ahead），顺序不能反。
   */
  captureBefore(runId: string, absPath: string, displayPath?: string): void {
    const normalizedPath = path.resolve(absPath);
    const dispPath = displayPath || normalizedPath;
    const fileHash = sha256(normalizedPath);
    const beforeFile = this.getBeforePath(runId, fileHash);
    const absentMarker = beforeFile + ".absent";
    const binaryMarker = beforeFile + ".binary";

    // 已 capture 过（惰性快照核心：同一文件只 capture 第一次）
    if (fs.existsSync(beforeFile) || fs.existsSync(absentMarker) || fs.existsSync(binaryMarker)) {
      logger.info(LogTag.Runtime, `[ReviewTracker] skip capture (already captured): ${dispPath}`);
      return;
    }

    fs.mkdirSync(path.dirname(beforeFile), { recursive: true });

    let exists = false;
    let fileKind: CapturedFileKind = "text";
    let size = 0;
    let contentHash = "";

    try {
      const detected = detectFileKind(normalizedPath);
      exists = true;
      fileKind = detected.kind;
      size = detected.size;
      contentHash = detected.contentHash;

      if (detected.kind === "binary") {
        // 二进制：不存 content，写 .binary 标记（只存 metadata）
        fs.writeFileSync(binaryMarker, JSON.stringify({ size, hash: contentHash }), "utf8");
      } else if (detected.content !== null) {
        // 文本 / large-text：存 content
        fs.writeFileSync(beforeFile, detected.content);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // 文件不存在 → 新建文件的 baseline = 不存在
        fs.writeFileSync(absentMarker, "", "utf8");
        exists = false;
      } else {
        throw err;
      }
    }

    // 追加 journal 事件
    this.appendJournal(runId, {
      type: "capture",
      absPath: normalizedPath,
      displayPath: dispPath,
      hash: fileHash,
      exists,
      fileKind,
      size,
      contentHash,
      capturedAt: Date.now(),
    });

    logger.info(
      LogTag.Runtime,
      `[ReviewTracker] captured: ${dispPath} exists=${exists} kind=${fileKind} size=${size}`,
    );
  }

  /**
   * 记录 rename / move 操作。
   * finalizeReview 时据此把"删除 a + 新建 b"识别为"rename a → b"。
   */
  recordRename(
    runId: string,
    fromAbsPath: string,
    toAbsPath: string,
    fromDisplayPath?: string,
    toDisplayPath?: string,
  ): void {
    const from = path.resolve(fromAbsPath);
    const to = path.resolve(toAbsPath);
    const fromDisp = fromDisplayPath || from;
    const toDisp = toDisplayPath || to;

    this.appendJournal(runId, {
      type: "rename",
      fromAbsPath: from,
      toAbsPath: to,
      fromDisplayPath: fromDisp,
      toDisplayPath: toDisp,
      at: Date.now(),
    });

    logger.info(LogTag.Runtime, `[ReviewTracker] rename: ${fromDisp} → ${toDisp}`);
  }

  /**
   * 读取 journal 事件（finalizeReview 用）。
   */
  readJournal(runId: string): JournalEvent[] {
    const journalPath = this.getJournalPath(runId);
    if (!fs.existsSync(journalPath)) return [];

    const content = fs.readFileSync(journalPath, "utf8");
    const events: JournalEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as JournalEvent);
      } catch {
        // 跳过损坏的行（追加写时崩溃可能产生半行）
      }
    }
    return events;
  }

  /**
   * 读取 BeforeImage 内容（finalizeReview 用）。
   * @returns 文件内容字符串；null 表示文件不存在或二进制（无 content）
   */
  readBeforeContent(runId: string, fileHash: string): string | null {
    const beforeFile = this.getBeforePath(runId, fileHash);
    const absentMarker = beforeFile + ".absent";
    const binaryMarker = beforeFile + ".binary";

    if (fs.existsSync(absentMarker)) return null; // 文件不存在（新建文件的 baseline）
    if (fs.existsSync(binaryMarker)) return null; // 二进制，无 content
    if (fs.existsSync(beforeFile)) return fs.readFileSync(beforeFile, "utf8");

    return null; // 未 capture（不该发生）
  }

  /**
   * 判断某 Run 是否有 Review 数据（journal 非空）。
   */
  hasReviewData(runId: string): boolean {
    return this.readJournal(runId).length > 0;
  }

  // ── finalizeReview：生成不可变 ReviewSnapshot ───────────

  /**
   * Run 结束时调用，生成不可变 ReviewSnapshot 并原子落盘。
   *
   * 流程：
   * 1. 读 journal，重建 capture + rename 事件
   * 2. 对每个文件：读 BeforeImage(A) + 当前文件(B)
   * 3. 用 structuredPatch 生成 diff（text 类），或只存 metadata（binary/large-text 类）
   * 4. 原子写 snapshot.json（.tmp + rename）
   *
   * @returns ReviewSnapshot；null 表示无 Review 数据或所有文件均未变化
   */
  finalizeReview(
    runId: string,
    startedAt: number,
    status: ReviewRunStatus,
  ): ReviewSnapshot | null {
    const events = this.readJournal(runId);
    if (events.length === 0) return null;

    // 重建 capture 状态：hash → capture event
    const captures = new Map<string, JournalCaptureEvent>();
    const renames: JournalRenameEvent[] = [];
    for (const event of events) {
      if (event.type === "capture") captures.set(event.hash, event);
      else if (event.type === "rename") renames.push(event);
    }

    const files: ReviewFileChange[] = [];
    const processedPaths = new Set<string>();

    // ── 处理 rename ──
    for (const ren of renames) {
      const fromHash = sha256(ren.fromAbsPath);
      const cap = captures.get(fromHash);
      const beforeContent = cap ? this.readBeforeContent(runId, fromHash) : null;
      const after = this.readFileSafe(ren.toAbsPath);

      const change = this.buildFileChange(
        cap ?? null,
        beforeContent,
        after,
        ren.fromDisplayPath,
        ren.toDisplayPath,
        ren.toAbsPath,
        "renamed",
      );
      if (change) {
        files.push(change);
        processedPaths.add(ren.fromAbsPath);
        processedPaths.add(ren.toAbsPath);
      }
    }

    // ── 处理普通 capture（非 rename）──
    for (const [hash, cap] of captures) {
      if (processedPaths.has(cap.absPath)) continue;

      const beforeContent = this.readBeforeContent(runId, hash);
      const after = this.readFileSafe(cap.absPath);

      let kind: ReviewFileChange["kind"];
      if (!cap.exists && after.exists) kind = "created";
      else if (cap.exists && !after.exists) kind = "deleted";
      else if (cap.exists && after.exists) {
        // 内容没变则跳过（binary 用 hash 比较，text 用内容比较）
        if (cap.fileKind === "binary" && cap.contentHash) {
          if (cap.contentHash === this.computeFileMeta(cap.absPath).hash) continue;
        } else if (beforeContent === after.content) {
          continue;
        }
        kind = "modified";
      } else continue; // beforeExists=false && afterExists=false：不可能

      const change = this.buildFileChange(
        cap,
        beforeContent,
        after,
        cap.displayPath,
        cap.displayPath,
        cap.absPath,
        kind,
      );
      if (change) files.push(change);
    }

    if (files.length === 0) return null;

    const snapshot: ReviewSnapshot = {
      runId,
      startedAt,
      endedAt: Date.now(),
      status,
      files,
    };

    this.atomicWriteSnapshot(runId, snapshot);
    logger.info(
      LogTag.Runtime,
      `[ReviewTracker] finalized: runId=${runId} files=${files.length} status=${status}`,
    );
    return snapshot;
  }

  /**
   * 读取已生成的 ReviewSnapshot（前端用）。
   */
  loadReview(runId: string): ReviewSnapshot | null {
    const snapshotPath = this.getSnapshotPath(runId);
    if (!fs.existsSync(snapshotPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as ReviewSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * 幂等获取 ReviewSnapshot：若已生成则直接返回，否则按给定状态补生成。
   *
   * 用途：
   * - 正常终止的 Run 在 harness-adapter 中已主动 finalize，此处直接命中缓存。
   * - 崩溃恢复（Run 被标记为 interrupted）时 snapshot 尚未生成，
   *   前端打开 Review 时调用此方法按 "halted" 状态补生成。
   *
   * @param startedAt Run 开始时间戳；崩溃恢复场景下从 run-store session 读取
   * @param status    Run 终止状态；崩溃恢复传 "halted"
   */
  finalizeIfPending(
    runId: string,
    startedAt: number,
    status: ReviewRunStatus,
  ): ReviewSnapshot | null {
    const existing = this.loadReview(runId);
    if (existing) return existing;
    if (!this.hasReviewData(runId)) return null;
    return this.finalizeReview(runId, startedAt, status);
  }

  // ── 内部辅助 ────────────────────────────────────────────

  /** 安全读文件：返回 { exists, content }，ENOENT 时不抛 */
  private readFileSafe(absPath: string): { exists: boolean; content: string | null } {
    try {
      const content = fs.readFileSync(absPath, "utf8");
      return { exists: true, content };
    } catch {
      return { exists: false, content: null };
    }
  }

  /**
   * 构建 ReviewFileChange。
   * - binary：只存 metadata，不 diff
   * - large-text：存 metadata，不自动 diff
   * - text：用 structuredPatch 生成 diff
   * - created：整文件 add
   * - deleted：整文件 remove
   */
  private buildFileChange(
    cap: JournalCaptureEvent | null,
    beforeContent: string | null,
    after: { exists: boolean; content: string | null },
    oldDisplayPath: string,
    newDisplayPath: string,
    afterAbsPath: string,
    kind: ReviewFileChange["kind"],
  ): ReviewFileChange | null {
    const beforeExists = cap?.exists ?? false;
    const afterExists = after.exists;
    const fileKind = cap?.fileKind;

    // ── binary：只存 metadata ──
    if (fileKind === "binary") {
      return {
        kind: "binary",
        oldPath: oldDisplayPath,
        newPath: newDisplayPath,
        additions: 0,
        deletions: 0,
        before: beforeExists && cap ? { size: cap.size, hash: cap.contentHash } : undefined,
        after: afterExists ? this.computeFileMeta(afterAbsPath) : undefined,
      };
    }

    // ── large-text：存 metadata，不自动 diff ──
    if (fileKind === "large-text") {
      return {
        kind: "large-text",
        oldPath: oldDisplayPath,
        newPath: newDisplayPath,
        additions: 0,
        deletions: 0,
        before: beforeExists && cap ? { size: cap.size, hash: cap.contentHash } : undefined,
        after: afterExists ? this.computeFileMeta(afterAbsPath) : undefined,
      };
    }

    // ── text 类：生成 diff ──

    // created：整文件 add
    if (kind === "created" && after.content !== null) {
      const { hunks, additions } = this.buildFullFileHunks(after.content, "add");
      return {
        kind: "created",
        oldPath: oldDisplayPath,
        newPath: newDisplayPath,
        additions,
        deletions: 0,
        hunks,
      };
    }

    // deleted：整文件 remove
    if (kind === "deleted" && beforeContent !== null) {
      const { hunks, deletions } = this.buildFullFileHunks(beforeContent, "remove");
      return {
        kind: "deleted",
        oldPath: oldDisplayPath,
        newPath: newDisplayPath,
        additions: 0,
        deletions,
        hunks,
      };
    }

    // modified / renamed：用 structuredPatch 生成 diff
    if (beforeContent !== null && after.content !== null) {
      const { hunks, additions, deletions } = this.diffTexts(beforeContent, after.content);
      // 纯 rename（内容没变）：不生成 hunks
      if (kind === "renamed" && additions === 0 && deletions === 0) {
        return {
          kind: "renamed",
          oldPath: oldDisplayPath,
          newPath: newDisplayPath,
          additions: 0,
          deletions: 0,
        };
      }
      return {
        kind,
        oldPath: oldDisplayPath,
        newPath: newDisplayPath,
        additions,
        deletions,
        hunks,
      };
    }

    return null;
  }

  /**
   * 用 structuredPatch 生成两个文本的 diff。
   * 返回结构化 hunks + 行级统计。
   */
  private diffTexts(before: string, after: string): {
    hunks: ReviewHunk[];
    additions: number;
    deletions: number;
  } {
    const patch = structuredPatch("", "", before, after, "", "", { context: 3 });
    let additions = 0;
    let deletions = 0;

    const hunks: ReviewHunk[] = patch.hunks.map((h) => {
      let oldLine = h.oldStart;
      let newLine = h.newStart;
      const lines: ReviewLine[] = [];

      for (const line of h.lines) {
        const prefix = line[0];
        const text = line.slice(1);

        if (prefix === "+") {
          lines.push({ type: "add", oldLine: null, newLine, text });
          newLine++;
          additions++;
        } else if (prefix === "-") {
          lines.push({ type: "remove", oldLine, newLine: null, text });
          oldLine++;
          deletions++;
        } else if (prefix === " ") {
          lines.push({ type: "context", oldLine, newLine, text });
          oldLine++;
          newLine++;
        }
        // "\\" 行（No newline at end of file）跳过
      }

      return {
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines,
      };
    });

    return { hunks, additions, deletions };
  }

  /**
   * 生成整文件 diff（新建文件全部 add，删除文件全部 remove）。
   */
  private buildFullFileHunks(content: string, type: "add" | "remove"): {
    hunks: ReviewHunk[];
    additions: number;
    deletions: number;
  } {
    // 去掉末尾空行（split 会在末尾 \n 后产生空字符串）
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const reviewLines: ReviewLine[] = lines.map((text, i) =>
      type === "add"
        ? { type: "add", oldLine: null, newLine: i + 1, text }
        : { type: "remove", oldLine: i + 1, newLine: null, text },
    );

    return {
      hunks: [
        {
          oldStart: type === "add" ? 0 : 1,
          oldLines: type === "add" ? 0 : lines.length,
          newStart: type === "add" ? 1 : 0,
          newLines: type === "add" ? lines.length : 0,
          lines: reviewLines,
        },
      ],
      additions: type === "add" ? lines.length : 0,
      deletions: type === "remove" ? lines.length : 0,
    };
  }

  /** 计算文件 metadata（size + SHA-256） */
  private computeFileMeta(absPath: string): ReviewFileMeta {
    const content = fs.readFileSync(absPath);
    return { size: content.length, hash: sha256(content) };
  }

  /** 原子写 snapshot.json（.tmp + rename） */
  private atomicWriteSnapshot(runId: string, snapshot: ReviewSnapshot): void {
    const snapshotPath = this.getSnapshotPath(runId);
    const tmpPath = `${snapshotPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(tmpPath, snapshotPath);
  }

  // ── 路径工具 ────────────────────────────────────────────

  private getRunDir(runId: string): string {
    return path.join(this.reviewsRoot, runId);
  }

  private getBeforePath(runId: string, fileHash: string): string {
    return path.join(this.getRunDir(runId), "before", fileHash);
  }

  private getJournalPath(runId: string): string {
    return path.join(this.getRunDir(runId), "journal.jsonl");
  }

  /** snapshot.json 路径（finalizeReview 原子写入用） */
  getSnapshotPath(runId: string): string {
    return path.join(this.getRunDir(runId), "snapshot.json");
  }

  // ── journal 追加写 ──────────────────────────────────────

  private appendJournal(runId: string, event: JournalEvent): void {
    const journalPath = this.getJournalPath(runId);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, JSON.stringify(event) + "\n", "utf8");
  }
}

// ── 单例工厂（和 HarnessRunStore 一致） ──────────────────

const sharedTrackers = new Map<string, RunReviewTracker>();

export function getRunReviewTracker(userDataRoot: string): RunReviewTracker {
  const key = path.resolve(userDataRoot);
  let tracker = sharedTrackers.get(key);
  if (!tracker) {
    tracker = new RunReviewTracker(key);
    sharedTrackers.set(key, tracker);
  }
  return tracker;
}
