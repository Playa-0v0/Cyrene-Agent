import { describe, expect, it } from "vitest";
import { buildMemoryGraphView } from "./memory-views";
import type { EntityGraphData } from "./entity-graph";
import type { L2Memory } from "./memory-types";

const graph: EntityGraphData = {
  entities: [
    { id: "a", name: "小鹿", type: "person", aliases: [], mentionCount: 3, firstMentionedAt: 1, lastMentionedAt: 3 },
    { id: "b", name: "台北", type: "place", aliases: [], mentionCount: 2, firstMentionedAt: 1, lastMentionedAt: 2 },
  ],
  relations: [],
};

const memory = {
  id: "m1", content: "和小鹿一起去了台北", triggerText: "小鹿與台北", sourceConversationId: "c1",
  createdAt: 1, lastAccessedAt: 1, accessCount: 0, weight: 50, isPinned: false, status: "active",
} as L2Memory;

describe("buildMemoryGraphView", () => {
  it("建立使用者根節點與實體類型關係", () => {
    const view = buildMemoryGraphView(graph, [memory], "Clark");
    expect(view.nodes[0]).toMatchObject({ name: "Clark", type: "user" });
    expect(view.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "a", relation: "提到的人" }),
      expect.objectContaining({ targetId: "b", relation: "相關地點" }),
    ]));
  });

  it("從同一記憶中的實體共現建立推導關係", () => {
    const view = buildMemoryGraphView(graph, [memory]);
    expect(view.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "同次提及", inferred: true }),
    ]));
  });
});
