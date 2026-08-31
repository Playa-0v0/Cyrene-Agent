import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { registerAppUpdateIpc } from "./app-update-ipc";

describe("registerAppUpdateIpc", () => {
  it("exposes update actions and broadcasts state changes", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const send = vi.fn();
    let listener: ((state: any) => void) | undefined;
    const state = { phase: "available" as const, currentVersion: "1.1.7", availableVersion: "1.2.0" };
    const service = {
      getState: vi.fn(() => state),
      check: vi.fn(async () => state),
      download: vi.fn(async () => ({ ...state, phase: "downloading" as const })),
      install: vi.fn(() => true),
      onStateChanged: vi.fn((next: (value: any) => void) => {
        listener = next;
        return () => undefined;
      }),
    };

    registerAppUpdateIpc({
      service,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      getWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
    });

    expect(await handlers.get(IPC.APP_UPDATE_GET_STATE)?.({})).toEqual(state);
    await handlers.get(IPC.APP_UPDATE_CHECK)?.({});
    await handlers.get(IPC.APP_UPDATE_DOWNLOAD)?.({});
    expect(await handlers.get(IPC.APP_UPDATE_INSTALL)?.({})).toBe(true);
    expect(service.check).toHaveBeenCalledOnce();
    expect(service.download).toHaveBeenCalledOnce();
    expect(service.install).toHaveBeenCalledOnce();

    listener?.(state);
    expect(send).toHaveBeenCalledWith(IPC.APP_UPDATE_STATE, state);
  });
});
