import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCardReminder,
  reminderCopy,
  isChatWindowActive,
  REMINDER_THROTTLE_MS,
  type CardReminderDeps,
  type CardReminderKind,
} from "./card-reminder";

function makeWindow(opts: { focused?: boolean; fullScreen?: boolean; destroyed?: boolean } = {}) {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    isFocused: () => opts.focused ?? false,
    isFullScreen: () => opts.fullScreen ?? false,
  } as unknown as import("electron").BrowserWindow;
}

function makeDeps(overrides: Partial<CardReminderDeps> = {}): CardReminderDeps & {
  showReminderPopup: ReturnType<typeof vi.fn>;
  hideReminderPopup: ReturnType<typeof vi.fn>;
  showTrayBalloon: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  showPetBubble: ReturnType<typeof vi.fn>;
} {
  return {
    getChatWindow: () => null,
    isPetVisible: () => true,
    showReminderPopup: vi.fn(),
    hideReminderPopup: vi.fn(),
    showTrayBalloon: vi.fn(),
    notify: vi.fn(),
    showPetBubble: vi.fn(),
    ...overrides,
  };
}

describe("reminderCopy", () => {
  it("question 与 plan 文案不同", () => {
    expect(reminderCopy("question").title).toContain("提问");
    expect(reminderCopy("plan").title).toContain("计划");
  });
});

describe("isChatWindowActive", () => {
  it("null/销毁视为未聚焦", () => {
    expect(isChatWindowActive(null)).toBe(false);
    expect(isChatWindowActive(makeWindow({ destroyed: true }))).toBe(false);
  });
  it("聚焦或全屏视为在看应用", () => {
    expect(isChatWindowActive(makeWindow({ focused: true }))).toBe(true);
    expect(isChatWindowActive(makeWindow({ fullScreen: true }))).toBe(true);
  });
  it("普通未聚焦窗口返回 false", () => {
    expect(isChatWindowActive(makeWindow())).toBe(false);
  });
});

describe("createCardReminder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("聚焦时仅应用内提示（不调任何外部通道）", () => {
    const deps = makeDeps({ getChatWindow: () => makeWindow({ focused: true }) });
    const remind = createCardReminder(deps);
    remind("question");
    expect(deps.showReminderPopup).not.toHaveBeenCalled();
    expect(deps.showTrayBalloon).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.showPetBubble).not.toHaveBeenCalled();
  });

  it("未聚焦时走 C+B+D+通知兜底", () => {
    const deps = makeDeps({ getChatWindow: () => makeWindow() });
    const remind = createCardReminder(deps);
    remind("question");
    expect(deps.showReminderPopup).toHaveBeenCalledTimes(1);
    expect(deps.showTrayBalloon).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.showPetBubble).toHaveBeenCalledTimes(1);
  });

  it("无聊天窗口时走 C+B+通知（D 也尝试，但桌宠可见判定生效）", () => {
    const deps = makeDeps({ getChatWindow: () => null });
    const remind = createCardReminder(deps);
    remind("plan");
    expect(deps.showReminderPopup).toHaveBeenCalledTimes(1);
    expect(deps.showTrayBalloon).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.showPetBubble).toHaveBeenCalledTimes(1);
  });

  it("桌宠隐藏时跳过 D 通道", () => {
    const deps = makeDeps({ getChatWindow: () => makeWindow(), isPetVisible: () => false });
    const remind = createCardReminder(deps);
    remind("question");
    expect(deps.showPetBubble).not.toHaveBeenCalled();
    expect(deps.showReminderPopup).toHaveBeenCalledTimes(1);
  });

  it("plan 文案传给浮窗与气泡", () => {
    const deps = makeDeps({ getChatWindow: () => makeWindow() });
    const remind = createCardReminder(deps);
    remind("plan");
    const popupArg = deps.showReminderPopup.mock.calls[0][0];
    expect(popupArg.kind).toBe("plan");
    expect(popupArg.title).toContain("计划");
    expect(deps.showPetBubble).toHaveBeenCalledWith(expect.stringContaining("计划"));
  });

  it("8s 节流：间隔内重复提醒被忽略", () => {
    const deps = makeDeps({ getChatWindow: () => makeWindow() });
    const remind = createCardReminder(deps);
    remind("question");
    vi.advanceTimersByTime(REMINDER_THROTTLE_MS - 1);
    remind("question");
    expect(deps.showReminderPopup).toHaveBeenCalledTimes(1);
  });

  it("超过节流间隔后再次提醒生效", () => {
    const deps = makeDeps({ getChatWindow: () => makeWindow() });
    const remind = createCardReminder(deps);
    remind("question");
    vi.advanceTimersByTime(REMINDER_THROTTLE_MS + 1);
    remind("question");
    expect(deps.showReminderPopup).toHaveBeenCalledTimes(2);
  });

  it("单个通道抛错不影响其余通道", () => {
    const deps = makeDeps({
      getChatWindow: () => makeWindow(),
      showReminderPopup: vi.fn(() => {
        throw new Error("popup fail");
      }),
    });
    const remind = createCardReminder(deps);
    expect(() => remind("question")).not.toThrow();
    expect(deps.showTrayBalloon).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it("kind 类型约束", () => {
    const kinds: CardReminderKind[] = ["question", "plan"];
    expect(kinds).toHaveLength(2);
  });
});
