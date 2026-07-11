import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenerBubbleController } from "./opener-bubble";

class FakeBubble {
  textContent = "";
  hidden = true;
  onclick: (() => void) | null = null;
  classList = { add: vi.fn(), remove: vi.fn() };
}

class FakeAudio {
  src: string;
  onended: (() => void) | null = null;
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  play = vi.fn(() => Promise.resolve());

  constructor(src: string) {
    this.src = src;
  }
}

const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.Audio = originalAudio;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  vi.restoreAllMocks();
});

describe("OpenerBubbleController", () => {
  it("releases the interrupted audio object URL before starting a new bubble", () => {
    Object.defineProperty(globalThis, "window", { value: { live2dSpeech: { prepare: vi.fn(), startMouth: vi.fn(), stopMouth: vi.fn() } }, configurable: true });
    const urls = ["blob:first", "blob:second"];
    const createObjectURL = vi.fn(() => urls.shift()!);
    const revokeObjectURL = vi.fn();
    const audios: FakeAudio[] = [];
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    globalThis.Audio = class extends FakeAudio {
      constructor(src: string) {
        super(src);
        audios.push(this);
      }
    } as unknown as typeof Audio;

    const controller = new OpenerBubbleController(new FakeBubble() as unknown as HTMLElement);
    const show = (controller as unknown as { handle: (payload: unknown) => void }).handle.bind(controller);
    const payload = { text: "hi", audioBase64: "AA==", format: "wav", durationMs: 10, sceneId: "s", itemId: "i" };

    show(payload);
    show(payload);

    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(audios[0].removeAttribute).toHaveBeenCalledWith("src");
    expect(audios[0].load).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
  });

  it("releases the active audio and DOM callback when disposed", () => {
    Object.defineProperty(globalThis, "window", { value: { live2dSpeech: { prepare: vi.fn(), startMouth: vi.fn(), stopMouth: vi.fn() } }, configurable: true });
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = vi.fn(() => "blob:active");
    URL.revokeObjectURL = revokeObjectURL;
    globalThis.Audio = FakeAudio as unknown as typeof Audio;
    const bubble = new FakeBubble();
    const controller = new OpenerBubbleController(bubble as unknown as HTMLElement);
    const show = (controller as unknown as { handle: (payload: unknown) => void }).handle.bind(controller);

    show({ text: "hi", audioBase64: "AA==", format: "wav", durationMs: 10, sceneId: "s", itemId: "i" });
    controller.dispose();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:active");
    expect(bubble.onclick).toBeNull();
    expect(bubble.hidden).toBe(true);
  });
});
