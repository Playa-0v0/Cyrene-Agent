import { Live2DManager } from "./live2d/manager";
import "./ui/theme";
import { InteractionController } from "./live2d/interaction";
import { MouseFocusController } from "./live2d/focus";
import { ExpressionResetController } from "./live2d/expression-reset";
import { MouthSyncController } from "./live2d/mouth-sync";
import { SpeakingMotionController } from "./live2d/speaking-motion";
import { OpenerBubbleController } from "./live2d/opener-bubble";
import { ClickThroughController } from "./live2d/click-through";
import { resolveAsset } from "../shared/renderer-base";

const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement;
if (!canvas) throw new Error("Canvas #live2d-canvas not found");
const openerBubbleEl = document.getElementById("opener-bubble");
const openerBubble = openerBubbleEl ? new OpenerBubbleController(openerBubbleEl) : null;
const petChatForm = document.getElementById("pet-chat-form") as HTMLFormElement | null;
const petChatInput = document.getElementById("pet-chat-input") as HTMLInputElement | null;
const petChatSubmit = document.getElementById("pet-chat-submit") as HTMLButtonElement | null;

if (!window.cyrene) {
  (window as unknown as { cyrene: unknown }).cyrene = {
    minimize: () => {},
    hide: () => {},
    quit: () => {},
    setInteractive: (_: boolean) => Promise.resolve(),
    setTextInputActive: (_active: boolean) => {},
    moveBy: (_dx: number, _dy: number) => {},
    moveTo: (_x: number, _y: number) => {},
    setDragging: (_isDragging: boolean) => {},
    captureFrame: () => Promise.resolve(null),
    getCursorPosition: () => Promise.resolve(null),
    onPetZoom: (_cb: (zoom: number) => void) => () => {},
  };
}

declare global {
  interface Window {
    live2dSpeech?: {
      onPrepare: (callback: () => void) => () => void;
      onMouthStart: (callback: (payload: { durationMs: number }) => void) => () => void;
      onMouthStop: (callback: () => void) => () => void;
    };
    live2dAction?: {
      onPlayAction: (callback: (target: import("../shared/live2d-actions").Live2DTarget) => void) => () => void;
    };
  }
}

let interaction: InteractionController | null = null;
let focus: MouseFocusController | null = null;
let expressionReset: ExpressionResetController | null = null;
let mouthSync: MouthSyncController | null = null;
let speakingMotion: SpeakingMotionController | null = null;
let clickThrough: ClickThroughController | null = null;
let petZoomOff: (() => void) | null = null;
let live2dSpeechOffs: Array<() => void> = [];
let petChatVisibilityOff: (() => void) | null = null;

function setPetChatVisible(visible: boolean): void {
  if (!petChatForm) return;
  petChatForm.hidden = !visible;
  if (!visible) petChatInput?.blur();
}

void window.petChat?.getInputVisibility()
  .then(setPetChatVisible)
  .catch(() => setPetChatVisible(false));
petChatVisibilityOff = window.petChat?.onInputVisibility(setPetChatVisible) ?? null;

let petChatPointerInside = false;
const holdPetInteraction = (): void => {
  clickThrough?.pause();
  void window.cyrene.setInteractive(true);
};
const releasePetInteraction = (): void => {
  if (petChatPointerInside || document.activeElement === petChatInput) return;
  clickThrough?.resume();
  void window.cyrene.setInteractive(false);
};

petChatForm?.addEventListener("pointerenter", () => {
  petChatPointerInside = true;
  holdPetInteraction();
});
petChatForm?.addEventListener("pointerleave", () => {
  petChatPointerInside = false;
  releasePetInteraction();
});
petChatInput?.addEventListener("focus", () => {
  holdPetInteraction();
  // macOS 輸入法候選窗的層級低於 screen-saver；輸入時暫時降低桌寵層級。
  window.cyrene.setTextInputActive(true);
});
petChatInput?.addEventListener("blur", () => {
  window.cyrene.setTextInputActive(false);
  releasePetInteraction();
});
petChatInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") petChatInput.blur();
});
petChatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = petChatInput?.value.trim() ?? "";
  if (!text || !window.petChat || !petChatInput || !petChatSubmit) return;
  petChatInput.value = "";
  petChatInput.disabled = true;
  petChatSubmit.disabled = true;
  const oldPlaceholder = petChatInput.placeholder;
  petChatInput.placeholder = "昔漣正在想…";
  try {
    const payload = await window.petChat.send(text);
    openerBubble?.show(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    openerBubble?.show({ text: message.replace(/^Error invoking remote method[^:]*:\s*/, "") || "暫時沒辦法回覆，請稍後再試。" });
  } finally {
    petChatInput.disabled = false;
    petChatSubmit.disabled = false;
    petChatInput.placeholder = oldPlaceholder;
    petChatInput.focus();
  }
});

const manager = new Live2DManager({
  canvas,
  width: window.innerWidth,
  height: window.innerHeight,
  modelPath: resolveAsset("models/cyrene/Cyrene.model3.json"),
  onLoad: () => {
    console.log("[Cyrene] Model loaded");
    const model = manager.getModel();
    if (!model) return;

    expressionReset = new ExpressionResetController(model);
    mouthSync = new MouthSyncController(model);
    speakingMotion = new SpeakingMotionController(model);
    live2dSpeechOffs = [
      window.live2dSpeech?.onPrepare(() => {
        void expressionReset?.resetNow();
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {}),
      window.live2dSpeech?.onMouthStart((payload) => {
        mouthSync?.start(Number(payload.durationMs ?? 0));
        speakingMotion?.start();
      }) ?? (() => {}),
      window.live2dSpeech?.onMouthStop(() => {
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {}),
    ];
    if (openerBubble) live2dSpeechOffs.push(openerBubble.attach());
    // LLM-driven action bridge: when Main sends a resolved Live2DTarget, play it.
    live2dSpeechOffs.push(
      window.live2dAction?.onPlayAction((target) => {
        void manager.playAction(target);
      }) ?? (() => {}),
    );
    interaction = new InteractionController(canvas, model, manager.getHitAreaDefs(), {
      onTrigger: (area) => {
        expressionReset?.restart();
        console.log("[Cyrene] hit", area.name, "->", area.group + ":" + area.motionName);
      },
      onMiss: (area) =>
        console.warn("[Cyrene] hit", area.name, "has no resolvable motion"),
    });

    focus = new MouseFocusController(canvas, model);
    focus.focusCenter(true);

    clickThrough = new ClickThroughController(canvas, manager, {
      onInteractive: (interactive) => void window.cyrene.setInteractive(interactive),
    });

    // Apply the persisted zoom on load and track future changes. The main
    // process has already resized the window to base × zoom; this rescales
    // the model to match.
    petZoomOff = window.cyrene.onPetZoom((zoom) => manager.applyZoom(zoom));

    // 啟動競態修復：主進程在渲染進程就緒前發的 PET_ZOOM 事件會被丟棄。
    // 註冊監聽後主動從磁盤讀一次 petZoom 並應用，確保重啟後模型大小生效。
    window.settings?.getGeneral().then((cfg) => {
      if (cfg?.petZoom && cfg.petZoom !== 1) {
        manager.applyZoom(cfg.petZoom);
      }
    }).catch(() => { /* 設置讀取失敗不影響加載 */ });

    (window as unknown as { __cyrene: unknown }).__cyrene = {
      manager,
      interaction,
      focus,
      expressionReset,
      resetExpression: () => expressionReset?.resetNow(),
    };
  },
  onError: (err) => {
    console.error("[Cyrene] Failed to load model:", err);
  },
});

manager.init();

window.addEventListener("resize", () => {
  manager.resize(window.innerWidth, window.innerHeight);
  focus?.focusCenter(true);
});

window.addEventListener("beforeunload", () => {
  window.cyrene.setTextInputActive(false);
  expressionReset?.dispose();
  expressionReset = null;
  for (const off of live2dSpeechOffs) off();
  live2dSpeechOffs = [];
  mouthSync?.dispose();
  mouthSync = null;
  speakingMotion?.dispose();
  speakingMotion = null;
  focus?.dispose();
  focus = null;
  clickThrough?.dispose();
  clickThrough = null;
  petZoomOff?.();
  petZoomOff = null;
  petChatVisibilityOff?.();
  petChatVisibilityOff = null;
  interaction?.dispose();
  interaction = null;
  manager.dispose();
});

let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let pendingPosition: { x: number; y: number } | null = null;
let rafId: number | null = null;
let dragOverlay: HTMLImageElement | null = null;
let dragToken = 0;

function clearDragOverlay(): void {
  if (dragOverlay) {
    dragOverlay.remove();
    dragOverlay = null;
  }
  canvas.style.visibility = "";
}

async function showDragOverlay(token: number): Promise<void> {
  const frame = await window.cyrene.captureFrame();
  if (!frame || token !== dragToken || !isDragging) return;

  const img = document.createElement("img");
  img.src = frame;
  img.alt = "";
  img.draggable = false;
  img.style.position = "fixed";
  img.style.inset = "0";
  img.style.width = "100vw";
  img.style.height = "100vh";
  img.style.objectFit = "contain";
  img.style.pointerEvents = "none";
  img.style.userSelect = "none";
  img.style.zIndex = "10";

  dragOverlay?.remove();
  dragOverlay = img;
  document.body.appendChild(img);
  canvas.style.visibility = "hidden";
}

function scheduleMoveTo(screenX: number, screenY: number): void {
  pendingPosition = {
    x: screenX - dragOffsetX,
    y: screenY - dragOffsetY,
  };
  if (rafId === null) {
    rafId = requestAnimationFrame(flushMove);
  }
}

function flushMove(): void {
  rafId = null;
  if (pendingPosition) {
    window.cyrene.moveTo(pendingPosition.x, pendingPosition.y);
    pendingPosition = null;
  }
}

function cancelPendingMove(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingPosition = null;
}

function finishDrag(): void {
  isDragging = false;
  dragToken += 1;
  cancelPendingMove();
  clearDragOverlay();
  manager.resume();
  focus?.resume();
  window.cyrene.setDragging(false);
  clickThrough?.resume();
}

// Click-through is driven per-pixel by ClickThroughController on pointermove.
// We only need enter/leave to bookend the cursor's stay in the window:
// entering hands control to the controller, leaving the window entirely
// means there's nothing to capture (and no move will fire), so pass through.
canvas.addEventListener("pointerenter", () => {
  clickThrough?.resume();
});

window.addEventListener("pointercancel", () => {
  if (isDragging) finishDrag();
});

window.addEventListener("blur", () => {
  if (isDragging) finishDrag();
});

canvas.addEventListener("pointerleave", () => {
  if (isDragging) return;
  void window.cyrene.setInteractive(false);
});

canvas.addEventListener("pointerdown", (e) => {
  isDragging = true;
  dragToken += 1;
  const token = dragToken;
  dragOffsetX = e.screenX - window.screenX;
  dragOffsetY = e.screenY - window.screenY;
  cancelPendingMove();
  clickThrough?.pause();
  focus?.pause(true);
  manager.pause();
  void window.cyrene.setInteractive(true);
  window.cyrene.setDragging(true);
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  void showDragOverlay(token);
});

window.addEventListener("pointermove", (e) => {
  if (!isDragging) return;
  scheduleMoveTo(e.screenX, e.screenY);
});

window.addEventListener("pointerup", (e) => {
  if (!isDragging) return;
  scheduleMoveTo(e.screenX, e.screenY);
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  flushMove();

  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {}

  // Release renderer capture before the main process detaches the docked
  // BrowserWindow. Changing the native parent while capture is active can
  // cancel the gesture on macOS.
  finishDrag();

  const rect = canvas.getBoundingClientRect();
  const outside =
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom;
  if (outside) void window.cyrene.setInteractive(false);
});
