/**
 * Learn 进度模块 — 类型定义。
 */

/** 主题掌握状态 */
export type TopicStatus = "learning" | "reviewing" | "mastered";

/** 单个主题的进度 */
export interface LearnTopicProgress {
  status: TopicStatus;
  /** 掌握度 0-100，第一版仅作粗略参考 */
  mastery: number;
  /** 尚未解决的问题 */
  unresolvedQuestions: string[];
  /** 最后学习时间 */
  lastStudiedAt: string;
}

/** progress.md 中的完整进度数据 */
export interface LearnProgress {
  schemaVersion: 1;
  currentTopic?: string;
  currentSection?: string;
  topics: Record<string, LearnTopicProgress>;
  nextStep?: string;
  updatedAt: string;
}

/** 结构化模型输出的进度更新增量 */
export interface LearnProgressUpdate {
  hasMeaningfulChange: boolean;
  topic?: string;
  section?: string;
  masteryDelta?: number;
  status?: TopicStatus;
  unresolvedQuestionsAdded?: string[];
  unresolvedQuestionsResolved?: string[];
  nextStep?: string;
}

/** progress.md 默认模板（YAML frontmatter + 正文） */
export function defaultProgressContent(): string {
  return `---
schemaVersion: 1
updatedAt: ${new Date().toISOString()}
topics: {}
---

# 学习进度

暂无记录。
`;
}
