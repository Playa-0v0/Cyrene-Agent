import { describe, expect, it, vi } from "vitest";

/**
 * Mock pixi-live2d-display before importing manager.ts so we don't have to
 * boot a real WebGL context in the test runner.
 */
vi.mock("pixi-live2d-display/cubism4", () => {
  return {
    Live2DModel: class {
      static from = vi.fn();
      motion = vi.fn(async () => true);
      expression = vi.fn(async () => true);
      internalModel = { motionManager: { definitions: { "动作#6": [{}, {}, {}, {}] } } };
    },
  };
});

vi.mock("pixi.js", () => {
  return {
    Application: class {
      renderer = { resize: vi.fn(), gl: null };
      stage = { addChild: vi.fn() };
      ticker = { stop: vi.fn(), start: vi.fn() };
      render = vi.fn();
      destroy = vi.fn();
    },
    Renderer: class {},
  };
});

// Minimal stub canvas; we never read pixels in these tests.
const fakeCanvas = {} as HTMLCanvasElement;

describe("Live2DManager.playAction", () => {
  it("is a no-op when the model is not loaded", async () => {
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });
    // init() will try to load the real model — we never call it, so model stays null
    await mgr.playAction({ kind: "expression", name: "墨镜" });
    // No assertion needed beyond "did not throw"
  });

  it("calls model.expression for an expression target", async () => {
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });
    // Inject a fake model directly
    (mgr as unknown as { model: unknown }).model = {
      motion: vi.fn(async () => true),
      expression: vi.fn(async () => true),
      internalModel: { motionManager: { definitions: {} } },
      scale: { set: vi.fn() },
      anchor: { set: vi.fn() },
      x: 0, y: 0, width: 100, height: 100,
      destroy: vi.fn(),
    };

    await mgr.playAction({ kind: "expression", name: "墨镜" });
    const model = (mgr as unknown as { model: { expression: ReturnType<typeof vi.fn> } }).model;
    expect(model.expression).toHaveBeenCalledWith("墨镜");
  });

  it("resolves motionName to the right index in the right group", async () => {
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });
    const motionMock = vi.fn(async () => true);
    (mgr as unknown as { model: unknown }).model = {
      motion: motionMock,
      expression: vi.fn(async () => true),
      internalModel: { motionManager: { definitions: { "动作#6": [{ Name: "动作回正" }, { Name: "Wink~" }, { Name: "我可爱吧~" }, { Name: "笑一笑吧~" }] } } },
      scale: { set: vi.fn() },
      anchor: { set: vi.fn() },
      x: 0, y: 0, width: 100, height: 100,
      destroy: vi.fn(),
    };
    // Inject the motionIndexMap that loadModel() would normally build from the JSON.
    (mgr as unknown as { motionIndexMap: Map<string, Map<string, number>> }).motionIndexMap = new Map([
      ["动作#6", new Map([
        ["动作回正", 0],
        ["Wink~", 1],
        ["我可爱吧~", 2],
        ["笑一笑吧~", 3],
      ])],
    ]);

    await mgr.playAction({ kind: "motion", group: "动作#6", motionName: "Wink~" });
    expect(motionMock).toHaveBeenCalledWith("动作#6", 1);

    await mgr.playAction({ kind: "motion", group: "动作#6", motionName: "笑一笑吧~" });
    expect(motionMock).toHaveBeenLastCalledWith("动作#6", 3);
  });

  it("falls back to expression() when motionName is not in the group", async () => {
    const { Live2DManager } = await import("./manager");
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });
    const motionMock = vi.fn(async () => false);
    const expressionMock = vi.fn(async () => true);
    (mgr as unknown as { model: unknown }).model = {
      motion: motionMock,
      expression: expressionMock,
      internalModel: { motionManager: { definitions: { "动作#6": [{ Name: "动作回正" }] } } },
      scale: { set: vi.fn() },
      anchor: { set: vi.fn() },
      x: 0, y: 0, width: 100, height: 100,
      destroy: vi.fn(),
    };

    await mgr.playAction({ kind: "motion", group: "动作#6", motionName: "Wink~" });
    expect(expressionMock).toHaveBeenCalledWith("Wink~");
  });

  it("swallows model errors and logs a warning", async () => {
    const { Live2DManager } = await import("./manager");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new Live2DManager({ canvas: fakeCanvas, width: 100, height: 100, modelPath: "/x" });
    (mgr as unknown as { model: unknown }).model = {
      motion: vi.fn(async () => { throw new Error("boom"); }),
      expression: vi.fn(async () => { throw new Error("boom"); }),
      internalModel: { motionManager: { definitions: {} } },
      scale: { set: vi.fn() },
      anchor: { set: vi.fn() },
      x: 0, y: 0, width: 100, height: 100,
      destroy: vi.fn(),
    };

    await mgr.playAction({ kind: "expression", name: "X" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
