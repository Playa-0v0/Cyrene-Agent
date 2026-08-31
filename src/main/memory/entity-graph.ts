// 简易实体关系图谱
//
// 从对话中自动提取实体（人物、地点、偏好、概念）和关系，
// 弥补纯向量检索无法回答"用户提到过的朋友是谁"这类关系型问题的不足。
//
// 存储为 JSON 文件，与 memory.json 并列。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { registerJiebaCustomWord, registerJiebaCustomWords } from "../rag/retriever";
import { logger, LogTag } from "../logger";

// ── 类型 ──

export interface EntityNode {
  id: string;
  name: string;
  type: "person" | "place" | "concept" | "preference" | "organization";
  aliases: string[];         // 其他叫法
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
}

export interface EntityRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;          // "likes" | "works_at" | "lives_in" | "friend_of" | "owns" | ...
  confidence: number;        // 0.0 ~ 1.0
  strength: number;          // 提及次数累积
}

interface EntityGraphData {
  entities: EntityNode[];
  relations: EntityRelation[];
}

// ── 实体抽取输入类型 ──
//
// 实体抽取改由 Memory Judge 的 LLM 调用顺手产出（零额外 LLM 调用 + 零正则）。
// 旧 ENTITY_PATTERNS 正则的 .{1,10} 贪婪匹配会把聊天碎片（标点/引号/emoji/单字）
// 当成实体，产生「」就收尾」「（用户发送表情包：哈」之类的垃圾文件。
// 详见 EntityGraph.ingestEntities()。

export interface ExtractedEntity {
  name: string;
  type: EntityNode["type"];
  aliases?: string[];
}

// ── 实体图谱管理器 ──

const dataDir = () => path.join(app.getPath("userData"));
const getPath = () => path.join(dataDir(), "entity-graph.json");

class EntityGraph {
  private cache: EntityGraphData | null = null;

  load(): EntityGraphData {
    if (this.cache) return this.cache;
    try {
      const filePath = getPath();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        this.cache = JSON.parse(raw) as EntityGraphData;
      } else {
        this.cache = { entities: [], relations: [] };
      }
    } catch {
      this.cache = { entities: [], relations: [] };
    }
    return this.cache;
  }

  save(): void {
    if (!this.cache) return;
    const filePath = getPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.cache, null, 2), "utf8");
  }

  /**
   * 把一批已抽取的实体入库。
   *
   * 实体由 Memory Judge 的 LLM 调用顺手产出（{name, type, aliases}），
   * 不再在此处用正则从原文抽取 —— 旧正则贪婪匹配会产生「」就收尾」之类的垃圾实体。
   * 调用方：MemoryScheduler 在 judge 返回后调本方法。
   */
  ingestEntities(extracted: ExtractedEntity[]): void {
    if (extracted.length === 0) return;
    const data = this.load();
    const now = Date.now();
    let changed = false;

    for (const { name, type, aliases } of extracted) {
      const trimmedName = name?.trim();
      if (!trimmedName || trimmedName.length < 2) continue;
      const existing = data.entities.find(
        (e) => e.name === trimmedName || e.aliases.includes(trimmedName),
      );
      if (existing) {
        existing.mentionCount++;
        existing.lastMentionedAt = now;
        // 合并 LLM 给出的新别名（去重），新别名也要喂给 jieba 避免误切
        const newAliases = (aliases ?? [])
          .map((a) => a.trim())
          .filter((a) => a && a !== existing.name && !existing.aliases.includes(a));
        if (newAliases.length > 0) {
          existing.aliases.push(...newAliases);
          for (const a of newAliases) this.feedSingleName(a);
          changed = true;
        }
      } else {
        data.entities.push({
          id: `ent_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name: trimmedName,
          type,
          aliases: (aliases ?? [])
            .map((a) => a.trim())
            .filter((a) => a && a !== trimmedName),
          mentionCount: 1,
          firstMentionedAt: now,
          lastMentionedAt: now,
        });
        changed = true;
        // 新实体立即喂给 jieba，避免后续对话中该词被错误切分
        this.feedSingleName(trimmedName);
      }
    }

    if (changed) this.save();
  }

/**
 * 把一个名称注册到 jieba 自定义词表。
 *
 * @node-rs/jieba 没有运行时 insertWord() —— 走「后处理重组」方案：
 * retriever.ts 的 tokenize() 在 jieba.cut() 之后会把被切散的自定义词
 * 重新合并。这个函数就是把 entity 名加进那张表的入口。
 */
  private feedSingleName(name: string): void {
    registerJiebaCustomWord(name);
  }

  /** 搜索与 query 相关的实体和关系，返回可读文本 */
  search(query: string): string {
    const data = this.load();
    if (data.entities.length === 0) return "";

    // 简单关键词匹配：找名称包含 query 中任意词的实体
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matchedEntities = data.entities.filter((e) =>
      queryTokens.some((t) => e.name.includes(t) || e.aliases.some((a) => a.includes(t))),
    );

    if (matchedEntities.length === 0) return "";

    const lines: string[] = [];
    for (const entity of matchedEntities) {
      const mentions = entity.mentionCount > 1 ? `（提及${entity.mentionCount}次）` : "";
      lines.push(`· ${entity.name}（${typeLabel(entity.type)}）${mentions}`);

      // 找该实体相关的所有关系
      const outgoing = data.relations.filter((r) => r.sourceId === entity.id);
      for (const rel of outgoing) {
        const target = data.entities.find((e) => e.id === rel.targetId);
        if (target) {
          lines.push(`  → ${rel.relation} ${target.name}`);
        }
      }

      const incoming = data.relations.filter((r) => r.targetId === entity.id);
      for (const rel of incoming) {
        const source = data.entities.find((e) => e.id === rel.sourceId);
        if (source) {
          lines.push(`  ← ${source.name} ${rel.relation}`);
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") : "";
  }

  /** 清空图谱 */
  reset(): void {
    this.cache = { entities: [], relations: [] };
    this.save();
  }
}

/** 获取所有实体名称（含别名） */
export function getAllEntityNames(): string[] {
  const graph = entityGraph.load();
  const names = new Set<string>();
  for (const e of graph.entities) {
    names.add(e.name);
    for (const a of e.aliases) names.add(a);
  }
  return [...names].filter((n) => n.length >= 2);
}

/**
 * 将实体图谱中的所有实体名注册到 jieba 自定义词表。
 * 调用时机：应用启动后、图谱有更新时。
 * 这样 "昔涟"、"小鹿" 等 AI 伴侣核心名词不会被错误切分。
 *
 * @node-rs/jieba 没有运行时 insertWord() —— 走「后处理重组」方案：
 * 词表存到 retriever.ts 的 customWords Set，tokenize() 切完后合并回去。
 */
export async function feedEntityNamesToJieba(): Promise<void> {
  const names = getAllEntityNames();
  if (names.length === 0) return;
  registerJiebaCustomWords(names);
  logger.info(LogTag.EntityGraph, `registered ${names.length} entity names into jieba custom dictionary`);
}

function typeLabel(type: EntityNode["type"]): string {
  switch (type) {
    case "person": return "人物";
    case "place": return "地点";
    case "organization": return "组织";
    case "preference": return "偏好";
    case "concept": return "概念";
  }
}

export const entityGraph = new EntityGraph();