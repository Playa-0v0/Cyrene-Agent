import type { Live2DManager } from "./manager";

export interface ClickThroughOptions {
  /**
   * Pixel alpha (0-255) at/above which a point is treated as the model and
   * thus clickable. Below it, the point is "transparent" and clicks should
   * pass through to whatever is behind the window. The default is low so
   * that anti-aliased model edges (semi-transparent) still register.
   */
  alphaThreshold?: number;
  /**
   * Invoked when the interactive state should change. `true` = the window
   * captures pointer events over the model; `false` = clicks pass through.
   */
  onInteractive?: (interactive: boolean) => void;
}

/**
 * Drives per-pixel click-through on a transparent Live2D window.
 *
 * Electron's `setIgnoreMouseEvents(ignore, { forward: true })` is a
 * whole-window, binary switch: either the entire window rectangle
 * captures clicks, or none of it does. It does *not* pass clicks through
 * transparent pixels. So a window-sized canvas with a model floating in
 * the middle would capture clicks everywhere, including the transparent
 * border.
 *
 * This controller samples the alpha of the rendered pixel under the cursor
 * on every pointer move (forwarded mouse-move messages still reach the
 * renderer even while the window ignores clicks). When the pixel is
 * transparent it tells the main process to ignore mouse events (clicks pass
 * through); when it's opaque it switches back to capturing so the user can
 * interact with the model. This is independent of model scale/position:
 * it reads the *actual rendered* frame, so any scale or layout works.
 */
export class ClickThroughController {
  private readonly canvas: HTMLCanvasElement;
  private readonly manager: Live2DManager;
  private readonly alphaThreshold: number;
  private readonly onInteractive?: (interactive: boolean) => void;

  private rafId: number | null = null;
  private pendingPoint: { x: number; y: number } | null = null;
  private currentState: boolean | null = null;
  private paused = false;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    manager: Live2DManager,
    options: ClickThroughOptions = {},
  ) {
    this.canvas = canvas;
    this.manager = manager;
    this.alphaThreshold = options.alphaThreshold ?? 10;
    this.onInteractive = options.onInteractive;

    canvas.addEventListener("pointermove", this.handleMove);
  }

  pause(): void {
    this.paused = true;
    this.cancelPending();
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    // Reset so the next move re-evaluates rather than short-circuiting on a
    // stale "already interactive" state.
    this.currentState = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
    this.canvas.removeEventListener("pointermove", this.handleMove);
  }

  private handleMove = (event: PointerEvent): void => {
    if (this.disposed || this.paused) return;
    this.pendingPoint = { x: event.clientX, y: event.clientY };
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(this.flush);
    }
  };

  private flush = (): void => {
    this.rafId = null;
    if (this.disposed || this.paused) return;
    const point = this.pendingPoint;
    this.pendingPoint = null;
    if (!point) return;

    const interactive = this.hitTestAlpha(point.x, point.y);
    if (interactive === this.currentState) return; // idempotent: avoid IPC spam
    this.currentState = interactive;
    this.onInteractive?.(interactive);
  };

  /**
   * True when the pixel under the given CSS coordinate is opaque enough to
   * belong to the model. Reads a single 1x1 pixel from the WebGL drawing
   * buffer (kept alive by `preserveDrawingBuffer`).
   */
  private hitTestAlpha(cssX: number, cssY: number): boolean {
    const gl = this.manager.getGL();
    if (!gl) return true; // before init, be permissive (don't block)

    const rect = this.canvas.getBoundingClientRect();
    // CSS -> canvas pixels. autoDensity makes the drawing buffer match the
    // CSS size * devicePixelRatio.
    const dpr = window.devicePixelRatio || 1;
    const x = Math.floor((cssX - rect.left) * dpr);
    const y = Math.floor((cssY - rect.top) * dpr);
    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) {
      return false;
    }
    // WebGL Y grows upward; readPixels origin is the bottom-left.
    const flippedY = gl.drawingBufferHeight - 1 - y;

    const buf = new Uint8Array(4);
    gl.readPixels(x, flippedY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf[3] >= this.alphaThreshold;
  }

  private cancelPending(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingPoint = null;
  }
}
