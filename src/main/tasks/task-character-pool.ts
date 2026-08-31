interface TaskCharacterDefinition {
  nickname: string;
  assetFileName: string;
}

export const TASK_CHARACTERS: readonly TaskCharacterDefinition[] = [
  { nickname: "风堇", assetFileName: "风堇.png" },
  { nickname: "刻律德菈", assetFileName: "刻律德菈.png" },
  { nickname: "长夜月", assetFileName: "长夜月.png" },
  { nickname: "遐蝶", assetFileName: "遐蝶.png" },
  { nickname: "缇宝", assetFileName: "缇宝.png" },
  ...["阿格莱雅", "白厄", "丹恒", "海瑟音", "那刻夏", "赛飞儿", "万敌"].map((nickname) => ({
    nickname,
    assetFileName: `${nickname}.png`,
  })),
];

export function getGoldenDescendantNames(): readonly string[] {
  return TASK_CHARACTERS.map((character) => character.nickname);
}

export function buildGoldenDescendantsPrompt(): string {
  const names = getGoldenDescendantNames();
  return names.length === 0
    ? ""
    : [
      `可委托的黄金裔：${names.join("、")}。`,
      "复杂任务可以调用 task 委托一位黄金裔在独立上下文中处理；调用时必须在 companion_id 中明确选择一位。",
      "用户指定某位黄金裔时优先选择该人；若该黄金裔正忙，工具会回告，你应换一位再委托。",
      "可以自然说“我让风堇先处理这部分”，不要说“派分身”；界面会同步展示你选择的黄金裔。",
    ].join("\n");
}

export interface TaskCharacterLease {
  nickname: string;
  assetFileName: string;
  release(): void;
}

/** Main-owned, per-conversation active character leases. */
export class TaskCharacterLeasePool {
  private readonly activeByConversation = new Map<string, Set<string>>();

  acquire(conversationId: string, nickname: string): TaskCharacterLease {
    const active = this.activeByConversation.get(conversationId) ?? new Set<string>();
    const selected = TASK_CHARACTERS.find((character) => character.nickname === nickname);
    if (!selected) throw new Error("TASK_COMPANION_UNKNOWN");
    if (active.has(selected.nickname)) throw new Error("TASK_COMPANION_BUSY");

    active.add(selected.nickname);
    this.activeByConversation.set(conversationId, active);
    let released = false;
    return {
      nickname: selected.nickname,
      assetFileName: selected.assetFileName,
      release: () => {
        if (released) return;
        released = true;
        active.delete(selected.nickname);
        if (active.size === 0) this.activeByConversation.delete(conversationId);
      },
    };
  }
}

export const taskCharacterLeasePool = new TaskCharacterLeasePool();
