import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";

const repoPath = path.resolve("/repo");
const userDataPath = path.resolve("/userdata");
const resourcesPath = path.resolve("/resources");
let packaged = false;

Object.defineProperty(process, "resourcesPath", { value: resourcesPath, configurable: true });

vi.mock("electron", () => ({
  app: {
    get isPackaged() { return packaged; },
    getAppPath: () => repoPath,
    getPath: (k: string) => k === "userData" ? userDataPath : "/tmp",
  },
}));

import { resolveMusicPaths } from "./paths";

describe("resolveMusicPaths (dev)", () => {
  it("resolves runtime + account paths under userData in development", () => {
    const p = resolveMusicPaths();
    expect(p.runtimeDir).toBe(path.join(userDataPath, "music", "netease", "runtime"));
    expect(p.accountPath).toBe(path.join(userDataPath, "music", "netease", "account.enc"));
    expect(p.resourceBaseDir).toBe(repoPath);
  });

  it("uses resourcesPath as resourceBaseDir when packaged", () => {
    packaged = true;
    const p = resolveMusicPaths();
    expect(p.resourceBaseDir).toBe(resourcesPath);
    packaged = false;
  });
});
