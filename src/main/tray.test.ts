import { describe, expect, it, vi } from "vitest";
import { buildTrayMenuTemplate } from "./tray";

describe("buildTrayMenuTemplate", () => {
  it("offers an entry that opens or focuses the chat window", () => {
    const createReactChatWindow = vi.fn();
    const template = buildTrayMenuTemplate({
      toggleMainWindow: vi.fn(),
      createReactChatWindow,
      createSidebarWindow: vi.fn(),
      createSettingsWindow: vi.fn(),
      createMusicPlayerWindow: vi.fn(),
    });
    const chatItem = template.find((item) => item.label === "打开聊天窗口");

    expect(chatItem).toBeDefined();
    chatItem?.click?.({} as never, {} as never, {} as never);
    expect(createReactChatWindow).toHaveBeenCalledOnce();
  });
});
