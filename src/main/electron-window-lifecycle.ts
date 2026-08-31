export interface TrackedWebContentsLike {
  id?: number;
  isDestroyed?: () => boolean;
}

export interface TrackedBrowserWindowLike {
  webContents?: TrackedWebContentsLike;
  isDestroyed: () => boolean;
  on: (event: "closed", listener: () => void) => unknown;
}

export interface WindowLifecycleDiagnostics {
  name: string;
  attached: boolean;
  windowDestroyed: boolean | null;
  webContentsId: number | null;
  webContentsDestroyed: boolean | null;
  closedCount: number;
}

export function createWindowLifecycleTracker<TWindow extends TrackedBrowserWindowLike>(
  name: string,
  options: { onClosed?: (win: TWindow) => void } = {},
) {
  let current: TWindow | null = null;
  let closedCount = 0;

  function clear(win?: TWindow): void {
    if (!win || current === win) current = null;
  }

  return {
    attach(win: TWindow): TWindow {
      current = win;
      win.on("closed", () => {
        closedCount += 1;
        clear(win);
        options.onClosed?.(win);
      });
      return win;
    },
    clear,
    getWindow: (): TWindow | null => current,
    getDiagnostics: (): WindowLifecycleDiagnostics => ({
      name,
      attached: current !== null,
      windowDestroyed: current ? current.isDestroyed() : null,
      webContentsId: current?.webContents?.id ?? null,
      webContentsDestroyed: current?.webContents?.isDestroyed?.() ?? null,
      closedCount,
    }),
  };
}
