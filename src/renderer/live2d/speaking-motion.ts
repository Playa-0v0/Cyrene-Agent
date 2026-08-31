import type { Live2DModel } from "pixi-live2d-display/cubism4";

const SWING_INTERVAL_MS = 5000;
const SWING_HOLD_MS = 1200;

export class SpeakingMotionController {
  private readonly model: Live2DModel;
  private intervalId: number | null = null;
  private resetId: number | null = null;
  private disposed = false;
  private nextSide: "left" | "right" = "left";

  constructor(model: Live2DModel) {
    this.model = model;
  }

  start(): void {
    if (this.disposed) return;
    this.stop(false);
    this.nextSide = "left";
    this.intervalId = window.setInterval(() => this.triggerSwing(), SWING_INTERVAL_MS);
  }

  stop(reset = true): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.resetId !== null) {
      window.clearTimeout(this.resetId);
      this.resetId = null;
    }
    if (reset) void this.resetSwing();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private triggerSwing(): void {
    const expression = this.nextSide === "left" ? "拽秋千1" : "拽秋千2";
    this.nextSide = this.nextSide === "left" ? "right" : "left";
    void this.applyExpression(expression);
    if (this.resetId !== null) window.clearTimeout(this.resetId);
    this.resetId = window.setTimeout(() => {
      this.resetId = null;
      void this.resetSwing();
    }, SWING_HOLD_MS);
  }

  private async resetSwing(): Promise<void> {
    await this.applyExpression("拽秋千回正");
  }

  private async applyExpression(name: string): Promise<void> {
    try {
      await this.model.expression(name);
    } catch (err) {
      console.warn("[Cyrene] speaking motion expression failed", name, err);
    }
  }
}
