import type { EntityGraphData, EntityNode } from "./entity-graph";
import type { L2Memory } from "./memory-types";

export interface MemoryGraphNode {
  id: string;
  name: string;
  type: EntityNode["type"] | "user";
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
}

export interface MemoryGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  strength: number;
  confidence: number;
  inferred: boolean;
}

export interface MemoryGraphView {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

const ROOT_ID = "memory-graph-user";
const MAX_ENTITIES = 24;

function rootRelation(type: EntityNode["type"]): string {
  if (type === "person") return "提到的人";
  if (type === "place") return "相關地點";
  if (type === "preference") return "偏好";
  if (type === "organization") return "相關組織";
  return "相關概念";
}

/**
 * 把既有實體圖譜與 L2 記憶組成可視化快照。
 * 圖譜尚無顯式 relation 時，以「使用者→實體」與同一記憶中的共現建立可解釋的推導邊。
 */
export function buildMemoryGraphView(
  graph: EntityGraphData,
  memories: L2Memory[],
  userName = "你",
): MemoryGraphView {
  const entities = [...graph.entities]
    .sort((a, b) => b.mentionCount - a.mentionCount || b.lastMentionedAt - a.lastMentionedAt)
    .slice(0, MAX_ENTITIES);
  const allowed = new Set(entities.map(entity => entity.id));
  const nodes: MemoryGraphNode[] = [
    { id: ROOT_ID, name: userName.trim() || "你", type: "user", mentionCount: memories.length, firstMentionedAt: 0, lastMentionedAt: Date.now() },
    ...entities.map(entity => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      mentionCount: entity.mentionCount,
      firstMentionedAt: entity.firstMentionedAt,
      lastMentionedAt: entity.lastMentionedAt,
    })),
  ];
  const edges: MemoryGraphEdge[] = entities.map(entity => ({
    id: `root-${entity.id}`,
    sourceId: ROOT_ID,
    targetId: entity.id,
    relation: rootRelation(entity.type),
    strength: Math.max(1, entity.mentionCount),
    confidence: 1,
    inferred: true,
  }));

  for (const relation of graph.relations) {
    if (!allowed.has(relation.sourceId) || !allowed.has(relation.targetId)) continue;
    edges.push({ ...relation, inferred: false });
  }

  const cooccurrence = new Map<string, { sourceId: string; targetId: string; strength: number }>();
  for (const memory of memories) {
    const text = `${memory.content}\n${memory.triggerText}`;
    const present = entities.filter(entity => text.includes(entity.name));
    for (let i = 0; i < present.length; i += 1) {
      for (let j = i + 1; j < present.length; j += 1) {
        const pair = [present[i].id, present[j].id].sort();
        const key = pair.join("|");
        const current = cooccurrence.get(key);
        if (current) current.strength += 1;
        else cooccurrence.set(key, { sourceId: pair[0], targetId: pair[1], strength: 1 });
      }
    }
  }
  for (const [key, pair] of cooccurrence) {
    if (edges.some(edge =>
      (edge.sourceId === pair.sourceId && edge.targetId === pair.targetId) ||
      (edge.sourceId === pair.targetId && edge.targetId === pair.sourceId))) continue;
    edges.push({
      id: `co-${key}`,
      sourceId: pair.sourceId,
      targetId: pair.targetId,
      relation: "同次提及",
      strength: pair.strength,
      confidence: Math.min(.9, .55 + pair.strength * .1),
      inferred: true,
    });
  }

  return { nodes, edges };
}
