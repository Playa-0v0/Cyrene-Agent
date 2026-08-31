// 不可变 Review 快照类型定义（main 生成 / renderer 消费）。
//
// 设计要点：
// - ReviewSnapshot 是「最终态」：一次 Run 结束（含崩溃恢复后）生成一次，之后不可变。
// - 数据源是 pre-mutation baseline（A）vs Run 结束时的当前文件（B），不是任务启动瞬间的快照。
// - 前端只负责渲染，不负责拼 diff、不负责读文件。
// - 和 chat-types.ts 的 ToolFileChange（per-tool 即时反馈、可变）职责分离。

/** Review 快照：一次 Run 结束时生成的不可变文件变更审查数据。 */
export interface ReviewSnapshot {
  /** 对应的 Run ID */
  runId: string;
  /** Run 开始时间戳（ms） */
  startedAt: number;
  /** Run 结束时间戳（ms） */
  endedAt: number;
  /** Run 的终止状态 */
  status: ReviewRunStatus;
  /** 文件级变更列表 */
  files: ReviewFileChange[];
}

export type ReviewRunStatus = "completed" | "failed" | "cancelled" | "halted";

/** 单文件在本次 Run 中的变更类型 */
export type ReviewFileKind =
  | "modified" // 内容被修改
  | "created" // 新建文件
  | "deleted" // 删除文件
  | "renamed" // 重命名/移动（可能伴随内容修改）
  | "binary" // 二进制文件，只存元信息
  | "large-text"; // 大型文本，diff 未自动生成

/** Review 中的单文件变更记录 */
export interface ReviewFileChange {
  /** 变更类型 */
  kind: ReviewFileKind;
  /**
   * 原路径。
   * - renamed：旧路径
   * - 其他：当前路径（modified/created/deleted/binary/large-text）
   */
  oldPath: string;
  /**
   * 新路径。
   * - renamed：新路径
   * - deleted：与 oldPath 相同（文件已不存在，路径仅用于展示）
   * - 其他：当前路径
   */
  newPath: string;
  /** 新增行数（binary/large-text 为 0） */
  additions: number;
  /** 删除行数（binary/large-text 为 0） */
  deletions: number;
  /** 结构化 diff hunk；binary/large-text 时省略 */
  hunks?: ReviewHunk[];
  /** 文件元信息（大小 + 内容哈希），用于 binary/large-text 展示 */
  before?: ReviewFileMeta;
  after?: ReviewFileMeta;
}

/** 文件元信息：大小 + SHA-1 内容哈希 */
export interface ReviewFileMeta {
  /** 文件大小（字节） */
  size: number;
  /** SHA-1 哈希（十六进制） */
  hash: string;
}

/** diff hunk：一段连续的变更区域，带旧行号/新行号 */
export interface ReviewHunk {
  /** 旧文件中的起始行号（1-based） */
  oldStart: number;
  /** 旧文件中的行数 */
  oldLines: number;
  /** 新文件中的起始行号（1-based） */
  newStart: number;
  /** 新文件中的行数 */
  newLines: number;
  /** 该 hunk 的行列表 */
  lines: ReviewLine[];
}

/** diff 单行：带旧行号/新行号，用于 inline diff 渲染 */
export interface ReviewLine {
  type: "context" | "add" | "remove";
  /** 旧文件中的行号（1-based）；add 行为 null */
  oldLine: number | null;
  /** 新文件中的行号（1-based）；remove 行为 null */
  newLine: number | null;
  text: string;
}
