// 卡片提醒浮窗管理器单元测试（任务八 · 通道 C）
// 覆盖：show 创建窗口并发送负载、view 动作聚焦聊天窗口并关闭、later 只关闭、
// 60 秒超时自动关闭、dispose 释放 IPC 监听并销毁窗口。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock electron（vi.hoisted 保证在 vi.mock 提升前初始化）──
const mocks = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockShow: vi.fn(),
  mockHide: vi.fn(),
  mockIsVisible: vi.fn(() => false),
  mockIsDestroyed: vi.fn(() => false),
  mockIsLoadingMainFrame: vi.fn(() => false),
  mockIsLoading: vi.fn(() => false),
  mockSetPosition: vi.fn(),
  mockDestroy: vi.fn(),
  mockOn: vi.fn(),
  mockOnce: vi.fn(),
  mockLoadURL: vi.fn(() => Promise.resolve()),
  mockLoadFile: vi.fn(() => Promise.resolve()),
  mockIpcOn: vi.fn(),
  mockIpcRemoveListener: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "/app" },
  ipcMain: {
    on: mocks.mockIpcOn,
    removeListener: mocks.mockIpcRemoveListener,
  },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
  BrowserWindow: vi.fn(function BrowserWindowMock() {
    return {
      webContents: {
        send: mocks.mockSend,
        isLoadingMainFrame: mocks.mockIsLoadingMainFrame,
        isLoading: mocks.mockIsLoading,
        once: mocks.mockOnce,
      },
      on: mocks.mockOn,
      once: mocks.mockOnce,
      setPosition: mocks.mockSetPosition,
      show: mocks.mockShow,
      hide: mocks.mockHide,
      isVisible: mocks.mockIsVisible,
      isDestroyed: mocks.mockIsDestroyed,
      destroy: mocks.mockDestroy,
      loadURL: mocks.mockLoadURL,
      loadFile: mocks.mockLoadFile,
    };
  }),
}));

// 运行环境固定为生产（isDev=false），保证测试路径确定性
vi.mock("../env", () => ({ isDev: false }));

import { createReminderPopupManager } from "./reminder-popup";
import { IPC } from "../../shared/ipc-channels";

describe("createReminderPopupManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("show 时创建浮窗窗口、定位到右下角并发送提醒负载", () => {
    const focusChatWindow = vi.fn();
    const popup = createReminderPopupManager({ focusChatWindow });

    popup.show({ kind: "question", title: "Cyrene", message: "当前存在提问卡片，请尽快回答" });

    // 创建了窗口并发送负载
    expect(mocks.mockSend).toHaveBeenCalledWith(IPC.REMINDER_POPUP_SHOW, {
      kind: "question",
      title: "Cyrene",
      message: "当前存在提问卡片，请尽快回答",
    });
    // 定位到主显示器右下角（1920×1080，宽 340 高 150，边距 16）
    expect(mocks.mockSetPosition).toHaveBeenCalledWith(1920 - 340 - 16, 1080 - 150 - 16);
  });

  it("view 动作触发 focusChatWindow 并关闭浮窗", () => {
    const focusChatWindow = vi.fn();
    const popup = createReminderPopupManager({ focusChatWindow });

    popup.show({ kind: "question", title: "Cyrene", message: "body" });

    // 模拟浮窗按钮回传：立即查看
    const actionHandler = mocks.mockIpcOn.mock.calls.find((c) => c[0] === IPC.REMINDER_POPUP_ACTION)?.[1];
    expect(actionHandler).toBeTypeOf("function");
    actionHandler({}, "view");

    expect(focusChatWindow).toHaveBeenCalledOnce();
    expect(mocks.mockHide).toHaveBeenCalled();
  });

  it("later 动作只关闭浮窗，不聚焦聊天窗口", () => {
    const focusChatWindow = vi.fn();
    const popup = createReminderPopupManager({ focusChatWindow });

    popup.show({ kind: "question", title: "Cyrene", message: "body" });

    const actionHandler = mocks.mockIpcOn.mock.calls.find((c) => c[0] === IPC.REMINDER_POPUP_ACTION)?.[1];
    actionHandler({}, "later");

    expect(focusChatWindow).not.toHaveBeenCalled();
    expect(mocks.mockHide).toHaveBeenCalled();
  });

  it("60 秒超时自动关闭浮窗", () => {
    vi.useFakeTimers();
    const popup = createReminderPopupManager({ focusChatWindow: vi.fn() });

    popup.show({ kind: "question", title: "Cyrene", message: "body" });
    expect(mocks.mockHide).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(mocks.mockHide).toHaveBeenCalled();
  });

  it("dispose 移除 IPC 监听并销毁窗口", () => {
    const popup = createReminderPopupManager({ focusChatWindow: vi.fn() });

    popup.show({ kind: "question", title: "Cyrene", message: "body" });
    popup.dispose();

    expect(mocks.mockIpcRemoveListener).toHaveBeenCalledWith(IPC.REMINDER_POPUP_ACTION, expect.any(Function));
    expect(mocks.mockDestroy).toHaveBeenCalled();
  });
});
