import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "./types";

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** 每个 key 一个 JSON 文件：<rootDir>/<key>.json */
export function createPluginStorage(rootDir: string): PluginStorage {
  mkdirSync(rootDir, { recursive: true });
  const fileFor = (key: string): string => path.join(rootDir, `${key}.json`);
  const assertKey = (key: string): void => {
    if (!KEY_RE.test(key)) {
      throw new Error(`非法存储 key: ${key}`);
    }
  };
  return {
    get<T>(key: string): T | undefined {
      assertKey(key);
      const p = fileFor(key);
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T): void {
      assertKey(key);
      const p = fileFor(key);
      // 原子写：先写临时文件再 rename，避免崩溃导致 JSON 损坏
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
      renameSync(tmp, p);
    },
    rootDir: () => rootDir,
  };
}
