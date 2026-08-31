export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): void;
}

/**
 * Ensures repeated launches wake the already-running application instead of
 * creating another Electron process and another pet window.
 */
export function installSingleInstanceGuard(
  app: SingleInstanceApp,
  focusExistingWindow: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", focusExistingWindow);
  return true;
}
