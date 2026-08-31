import * as path from "node:path";
import { app } from "electron";

export interface MusicPaths {
  runtimeDir: string;
  accountPath: string;
  resourceBaseDir: string;
}

export function resolveMusicPaths(): MusicPaths {
  const isPackaged = app.isPackaged;
  const userDataMusic = path.join(app.getPath("userData"), "music", "netease");
  return {
    runtimeDir: path.join(userDataMusic, "runtime"),
    accountPath: path.join(userDataMusic, "account.enc"),
    resourceBaseDir: isPackaged ? process.resourcesPath : app.getAppPath(),
  };
}
