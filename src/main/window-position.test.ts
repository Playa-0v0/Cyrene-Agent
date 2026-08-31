import { afterEach, describe, expect, it, vi } from "vitest";
import { PetWindowMoveController, type PetWindowLike } from "./pet-window-movement";
import {
  normalizeWindowCoordinate,
  normalizeWindowPosition,
  WINDOW_COORDINATE_LIMIT,
} from "./window-position";

describe("window position normalization", () => {
  it("rounds finite coordinates to integers", () => {
    expect(normalizeWindowCoordinate(123.4)).toBe(123);
    expect(normalizeWindowCoordinate(-123.6)).toBe(-124);
    expect(normalizeWindowPosition(10.4, -20.6)).toEqual({ x: 10, y: -21 });
  });

  it("rejects non-number and non-finite coordinates", () => {
    expect(normalizeWindowCoordinate(undefined)).toBeNull();
    expect(normalizeWindowCoordinate("12")).toBeNull();
    expect(normalizeWindowCoordinate(Number.NaN)).toBeNull();
    expect(normalizeWindowCoordinate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeWindowCoordinate(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("rejects the whole position when either coordinate is invalid", () => {
    expect(normalizeWindowPosition(Number.NaN, 20)).toBeNull();
    expect(normalizeWindowPosition(10, undefined)).toBeNull();
  });

  it("clamps extreme coordinates to the safety limit", () => {
    expect(normalizeWindowCoordinate(WINDOW_COORDINATE_LIMIT + 1)).toBe(WINDOW_COORDINATE_LIMIT);
    expect(normalizeWindowCoordinate(-WINDOW_COORDINATE_LIMIT - 1)).toBe(-WINDOW_COORDINATE_LIMIT);
    expect(normalizeWindowPosition(2_000_000, -2_000_000)).toEqual({
      x: WINDOW_COORDINATE_LIMIT,
      y: -WINDOW_COORDINATE_LIMIT,
    });
  });
});

describe("pet window move controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createWindow(position: [number, number] = [100, 200]): PetWindowLike & {
    setPosition: ReturnType<typeof vi.fn>;
  } {
    let current = position;
    return {
      isDestroyed: () => false,
      getPosition: () => current,
      setPosition: vi.fn((x: number, y: number) => {
        current = [x, y];
      }),
    };
  }

  it("coalesces absolute moves and applies only the latest position", () => {
    vi.useFakeTimers();
    const window = createWindow();
    const controller = new PetWindowMoveController(() => window, vi.fn());

    controller.queueAbsolute(110, 210);
    controller.queueAbsolute(120, 220);
    controller.queueAbsolute(130, 230);
    expect(window.setPosition).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(window.setPosition).toHaveBeenCalledTimes(1);
    expect(window.setPosition).toHaveBeenCalledWith(130, 230, false);
  });

  it("flushes the last move and persists the actual position when dragging ends", () => {
    vi.useFakeTimers();
    const window = createWindow();
    const persist = vi.fn();
    const controller = new PetWindowMoveController(() => window, persist);

    controller.queueAbsolute(150.4, 250.6);
    controller.finishDragging();

    expect(window.setPosition).toHaveBeenCalledWith(150, 251, false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ x: 150, y: 251 });
    vi.runAllTimers();
    expect(window.setPosition).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid coordinates without moving or persisting them", () => {
    vi.useFakeTimers();
    const window = createWindow();
    const persist = vi.fn();
    const controller = new PetWindowMoveController(() => window, persist);

    controller.queueAbsolute(Number.NaN, 200);
    controller.moveRelative(Number.POSITIVE_INFINITY, 10);
    vi.runAllTimers();

    expect(window.setPosition).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("skips duplicate positions and ignores destroyed windows", () => {
    vi.useFakeTimers();
    const window = createWindow([100, 200]);
    const controller = new PetWindowMoveController(() => window, vi.fn());

    controller.queueAbsolute(100, 200);
    vi.runAllTimers();
    expect(window.setPosition).not.toHaveBeenCalled();

    const destroyedWindow: PetWindowLike = {
      isDestroyed: () => true,
      getPosition: vi.fn(),
      setPosition: vi.fn(),
    };
    const destroyedController = new PetWindowMoveController(() => destroyedWindow, vi.fn());
    destroyedController.queueAbsolute(300, 400);
    destroyedController.finishDragging();
    expect(destroyedWindow.getPosition).not.toHaveBeenCalled();
    expect(destroyedWindow.setPosition).not.toHaveBeenCalled();
  });
});
