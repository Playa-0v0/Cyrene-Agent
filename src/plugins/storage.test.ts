import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginStorage } from "./storage";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("createPluginStorage", () => {
  it("get/set 落盘并可读回；缺失返回 undefined", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    const s = createPluginStorage(tmp);
    s.set("cfg", { a: 1 });
    expect(s.get<{ a: number }>("cfg")).toEqual({ a: 1 });
    expect(s.get("missing")).toBeUndefined();
    expect(s.rootDir()).toBe(tmp);
  });

  it("非法 key 抛错", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    const s = createPluginStorage(tmp);
    expect(() => s.set("../evil", 1)).toThrow(/非法存储 key/);
    expect(() => s.get("a/b")).toThrow(/非法存储 key/);
  });
});
