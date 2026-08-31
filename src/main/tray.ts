import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import { getCurrentAppIconPath } from "./windows/window-state";

export interface CreateTrayDependencies {
  toggleMainWindow: () => void;
  createReactChatWindow: () => void;
  createSidebarWindow: () => void;
  createSettingsWindow: () => void;
  createMusicPlayerWindow: () => void;
}

export function buildTrayMenuTemplate(deps: CreateTrayDependencies): MenuItemConstructorOptions[] {
  return [
    {
      label: "打开聊天窗口",
      click: () => { deps.createReactChatWindow(); },
    },
    {
      label: "打开状态面板",
      click: () => { deps.createSidebarWindow(); },
    },
    {
      label: "打开音乐播放器",
      click: () => { deps.createMusicPlayerWindow(); },
    },
    {
      label: "设置",
      click: () => { deps.createSettingsWindow(); },
    },
    {
      label: "显示/隐藏桌宠",
      click: () => { deps.toggleMainWindow(); },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => { app.quit(); },
    },
  ];
}

export function createTray(deps: CreateTrayDependencies): Tray {
  const icon = nativeImage.createFromPath(getCurrentAppIconPath());
  const tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate(deps));

  tray.setToolTip("Cyrene");
  tray.setContextMenu(contextMenu);

  return tray;
}
