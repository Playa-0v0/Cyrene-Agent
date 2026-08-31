export interface LoginItemSettingsApp {
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export interface InstallerOptionsFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  unlinkSync(path: string): void;
}

export function syncLaunchAtLogin(
  enabled: boolean,
  app: LoginItemSettingsApp,
): void {
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * Returns the one-shot preference selected in the installer, then removes it so
 * future starts continue to respect the user's in-app setting.
 */
export function consumeInstallerLaunchAtLoginSelection(
  path: string,
  fileSystem: InstallerOptionsFileSystem,
): boolean | null {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(path, "utf8")) as { launchAtLogin?: unknown };
    fileSystem.unlinkSync(path);
    return typeof parsed.launchAtLogin === "boolean" ? parsed.launchAtLogin : null;
  } catch {
    return null;
  }
}

export function applyInstallerLaunchAtLoginSelection<T extends object>(
  settings: T,
  selection: boolean | null,
): T {
  return selection === null ? settings : { ...settings, launchAtLogin: selection };
}
