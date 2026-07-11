import type { Live2DModel } from "pixi-live2d-display/cubism4";

export interface FocusOptions {
  pollIntervalMs?: number;
}

/**
 * Drives Live2D eye/head focus from the system cursor position.
 *
 * Pointer events keep the focus responsive while the cursor is over the
 * transparent pet window. A lightweight IPC poll keeps the model looking at
 * the cursor after it leaves the window bounds.
 */
export class MouseFocusController {
  private readonly canvas: HTMLCanvasElement;
  private readonly model: Live2DModel;
  private readonly pollIntervalMs: number;

  private paused = false;
  private disposed = false;
  private pollTimer: number | null = null;
  private rafId: number | null = null;
  private polling = false;
  private pendingPoint: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, model: Live2DModel, options: FocusOptions = {}) {
    this.canvas = canvas;
    this.model = model;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;

    canvas.addEventListener("pointermove", this.handleMove);
    this.startPolling();
  }

  pause(reset = false): void {
    this.paused = true;
    this.cancelPending();
    this.stopPolling();
    if (reset) this.focusCenter();
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    this.startPolling();
  }

  focusCenter(instant = false): void {
    const rect = this.canvas.getBoundingClientRect();
    this.model.focus(rect.width / 2, rect.height / 2, instant);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
    this.stopPolling();
    this.canvas.removeEventListener("pointermove", this.handleMove);
  }

  private handleMove = (event: PointerEvent): void => {
    if (this.disposed || this.paused) return;
    this.scheduleFocus(event.clientX, event.clientY);
  };

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => {
      void this.pollGlobalCursor();
    }, this.pollIntervalMs);
    void this.pollGlobalCursor();
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollGlobalCursor(): Promise<void> {
    if (this.disposed || this.paused || this.polling) return;
    this.polling = true;
    try {
      const cursor = await window.cyrene.getCursorPosition();
      if (!cursor || this.disposed || this.paused) return;
      this.scheduleFocus(cursor.x - window.screenX, cursor.y - window.screenY);
    } finally {
      this.polling = false;
    }
  }

  private scheduleFocus(x: number, y: number): void {
    this.pendingPoint = { x, y };
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.flushFocus);
    }
  }

  private flushFocus = (): void => {
    this.rafId = null;
    if (!this.pendingPoint || this.paused || this.disposed) return;
    this.model.focus(this.pendingPoint.x, this.pendingPoint.y);
    this.pendingPoint = null;
  };

  private cancelPending(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingPoint = null;
  }
}
