import type { Live2DModel } from "pixi-live2d-display/cubism4";

/**
 * Resolved description of a single hit area and the motion/expression it triggers.
 *
 * The model's HitAreas use a "group:motionName" trigger string. Some entries
 * point at real motion files, while others are expression-only pseudo motions,
 * so both paths are resolved here.
 */
export interface HitAreaDef {
  name: string;
  id: string;
  group: string;
  motionName: string;
  motionIndex: number;
  expressionName?: string;
}

export interface InteractionOptions {
  /**
   * Max pointer travel (in CSS pixels) between pointerdown and pointerup
   * for the gesture to still count as a click.
   */
  clickThreshold?: number;
  onTrigger?: (area: HitAreaDef) => void;
  onMiss?: (area: HitAreaDef) => void;
}

/**
 * Maps pointer clicks on the Live2D canvas to model hit-area actions.
 */
export class InteractionController {
  private readonly canvas: HTMLCanvasElement;
  private readonly model: Live2DModel;
  private readonly hitAreaByName: Map<string, HitAreaDef>;
  private readonly clickThreshold: number;
  private readonly onTrigger?: (area: HitAreaDef) => void;
  private readonly onMiss?: (area: HitAreaDef) => void;

  private downX = 0;
  private downY = 0;
  private downHits: HitAreaDef[] = [];
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    model: Live2DModel,
    hitAreaDefs: HitAreaDef[],
    options: InteractionOptions = {},
  ) {
    this.canvas = canvas;
    this.model = model;
    this.clickThreshold = options.clickThreshold ?? 5;
    this.onTrigger = options.onTrigger;
    this.onMiss = options.onMiss;
    this.hitAreaByName = new Map(hitAreaDefs.map((a) => [a.name, a]));

    canvas.addEventListener("pointerdown", this.handleDown);
    canvas.addEventListener("pointerup", this.handleUp);
    canvas.addEventListener("pointercancel", this.handleCancel);
  }

  private handleDown = (e: PointerEvent): void => {
    if (this.disposed) return;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downHits = this.resolveHits(e.clientX, e.clientY);
  };

  private handleUp = (e: PointerEvent): void => {
    if (this.disposed) return;
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    const dist = Math.hypot(dx, dy);
    const hits = this.downHits;
    this.downHits = [];
    if (dist > this.clickThreshold) return;
    void this.fire(hits);
  };

  private handleCancel = (): void => {
    this.downHits = [];
  };

  private resolveHits(x: number, y: number): HitAreaDef[] {
    const names = this.model.hitTest(x, y);
    if (!names || names.length === 0) return [];
    const defs: HitAreaDef[] = [];
    for (const name of names) {
      const def = this.hitAreaByName.get(name);
      if (def) defs.push(def);
    }
    return defs;
  }

  private async fire(hits: HitAreaDef[]): Promise<void> {
    if (hits.length === 0) return;

    for (let i = 0; i < hits.length; i++) {
      const def = hits[i];
      if (await this.tryPlay(def)) {
        this.onTrigger?.(def);
        return;
      }
      if (i === 0) this.onMiss?.(def);
    }
  }

  private async tryPlay(def: HitAreaDef): Promise<boolean> {
    const defs = this.model.internalModel.motionManager.definitions[def.group];
    if (def.motionIndex >= 0 && defs && def.motionIndex < defs.length) {
      try {
        if (await this.model.motion(def.group, def.motionIndex)) return true;
      } catch (err) {
        console.warn("[Cyrene] motion failed", def.group, def.motionName, err);
      }
    }

    const expressionName = def.expressionName ?? def.motionName;
    try {
      return await this.model.expression(expressionName);
    } catch (err) {
      console.warn("[Cyrene] expression failed", expressionName, err);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.handleDown);
    this.canvas.removeEventListener("pointerup", this.handleUp);
    this.canvas.removeEventListener("pointercancel", this.handleCancel);
  }
}
