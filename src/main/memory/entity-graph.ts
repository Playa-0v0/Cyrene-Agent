// 簡易實體關係圖譜
//
// 從對話中自動提取實體（人物、地點、偏好、概念）和關係，
// 彌補純向量檢索無法回答"用戶提到過的朋友是誰"這類關係型問題的不足。
//
// 存儲為 JSON 文件，與 memory.json 並列。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { registerJiebaCustomWord, registerJiebaCustomWords } from "../rag/retriever";

// ── 類型 ──

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
  strength: number;          // 提及次數累積
}

export interface EntityGraphData {
  entities: EntityNode[];
  relations: EntityRelation[];
}

// ── 簡單解析器（不依賴 LLM，用正則啟發式提取） ──

// 常見實體觸發模式
const ENTITY_PATTERNS: Array<{ type: EntityNode["type"]; patterns: RegExp[] }> = [
  {
    type: "person",
    patterns: [
      /我的朋友(.{1,6})/g,
      /我認識(.{1,6})/g,
      /同事(.{1,6})/g,
      /叫(.{1,4})(?:的人|的朋友|的同事|的老闆)/g,
      /有.{0,4}朋友.{0,4}(.{1,6})/g,
      /(.{1,4})是我的朋友/g,
    ],
  },
  {
    type: "place",
    patterns: [
      /住在(.{1,10})/g,
      /在(.{1,10})(?:工作|學習|生活|住|上班|上學)/g,
      /去了(.{1,10})/g,
      /在(.{1,10})出差/g,
    ],
  },
  {
    type: "organization",
    patterns: [
      /在(.{1,10})(?:公司|單位|工作室|團隊|學校|大學|學院)/g,
      /(.{1,10})公司/g,
    ],
  },
  {
    type: "preference",
    patterns: [
      /喜歡(.{1,10})(?:的東西|的活動|的食物|的音樂|的運動|的遊戲|的動畫|的漫畫)/g,
      /最愛(.{1,10})/g,
      /討厭(.{1,10})(?:的東西|的事情)/g,
    ],
  },
];

/** 從文本中啟發式提取實體名，返回 [type, name] 列表 */
export function extractEntitiesFromText(text: string): Array<{ type: EntityNode["type"]; name: string }> {
  const results: Array<{ type: EntityNode["type"]; name: string }> = [];
  const seen = new Set<string>();

  for (const { type, patterns } of ENTITY_PATTERNS) {
    for (const regex of patterns) {
      const matches = text.matchAll(regex);
      for (const m of matches) {
        const name = m[1]?.trim();
        if (name && name.length >= 2 && name.length <= 10 && !seen.has(`${type}:${name}`)) {
          seen.add(`${type}:${name}`);
          results.push({ type, name });
        }
      }
    }
  }

  return results;
}

// ── 實體圖譜管理器 ──

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

  /** 提供給設定頁的只讀快照，避免 UI 直接碰觸圖譜存儲。 */
  snapshot(): EntityGraphData {
    const data = this.load();
    return {
      entities: data.entities.map(entity => ({ ...entity, aliases: [...entity.aliases] })),
      relations: data.relations.map(relation => ({ ...relation })),
    };
  }

  save(): void {
    if (!this.cache) return;
    const filePath = getPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.cache, null, 2), "utf8");
  }

  /** 從一條對話文本中提取實體併入庫 */
  ingest(text: string): void {
    const data = this.load();
    const extracted = extractEntitiesFromText(text);
    const now = Date.now();
    let hasNewEntity = false;

    for (const { type, name } of extracted) {
      const existing = data.entities.find(
        (e) => e.name === name || e.aliases.includes(name),
      );
      if (existing) {
        existing.mentionCount++;
        existing.lastMentionedAt = now;
      } else {
        data.entities.push({
          id: `ent_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          type,
          aliases: [],
          mentionCount: 1,
          firstMentionedAt: now,
          lastMentionedAt: now,
        });
        hasNewEntity = true;
        // 新實體立即餵給 jieba，避免後續對話中該詞被錯誤切分
        this.feedSingleName(name);
      }
    }

    if (extracted.length > 0) this.save();
  }

/**
 * 把一個名稱註冊到 jieba 自定義詞表。
 *
 * @node-rs/jieba 沒有運行時 insertWord() —— 走「後處理重組」方案：
 * retriever.ts 的 tokenize() 在 jieba.cut() 之後會把被切散的自定義詞
 * 重新合併。這個函數就是把 entity 名加進那張表的入口。
 */
  private feedSingleName(name: string): void {
    registerJiebaCustomWord(name);
  }

  /** 搜索與 query 相關的實體和關係，返回可讀文本 */
  search(query: string): string {
    const data = this.load();
    if (data.entities.length === 0) return "";

    // 簡單關鍵詞匹配：找名稱包含 query 中任意詞的實體
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matchedEntities = data.entities.filter((e) =>
      queryTokens.some((t) => e.name.includes(t) || e.aliases.some((a) => a.includes(t))),
    );

    if (matchedEntities.length === 0) return "";

    const lines: string[] = [];
    for (const entity of matchedEntities) {
      const mentions = entity.mentionCount > 1 ? `（提及${entity.mentionCount}次）` : "";
      lines.push(`· ${entity.name}（${typeLabel(entity.type)}）${mentions}`);

      // 找該實體相關的所有關係
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

  /** 清空圖譜 */
  reset(): void {
    this.cache = { entities: [], relations: [] };
    this.save();
  }
}

/** 獲取所有實體名稱（含別名） */
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
 * 將實體圖譜中的所有實體名註冊到 jieba 自定義詞表。
 * 調用時機：應用啟動後、圖譜有更新時。
 * 這樣 "昔漣"、"小鹿" 等 AI 伴侶核心名詞不會被錯誤切分。
 *
 * @node-rs/jieba 沒有運行時 insertWord() —— 走「後處理重組」方案：
 * 詞表存到 retriever.ts 的 customWords Set，tokenize() 切完後合併回去。
 */
export async function feedEntityNamesToJieba(): Promise<void> {
  const names = getAllEntityNames();
  if (names.length === 0) return;
  registerJiebaCustomWords(names);
  console.log(`[EntityGraph] 註冊 ${names.length} 個實體名到 jieba 自定義詞表`);
}

function typeLabel(type: EntityNode["type"]): string {
  switch (type) {
    case "person": return "人物";
    case "place": return "地點";
    case "organization": return "組織";
    case "preference": return "偏好";
    case "concept": return "概念";
  }
}

export const entityGraph = new EntityGraph();
