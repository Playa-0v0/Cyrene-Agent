import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPluginDir } from "./loader";
import { validateManifestData } from "./manifest-validation";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

const validInput = {
  apiVersion: 1,
  id: "demo",
  name: "演示",
  version: "1.0.0",
  description: "d",
  author: "a",
  entry: "index.cjs",
  defaultEnabled: true,
};

function inspectWithData(data: unknown) {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-schema-test-"));
  const dir = path.join(tmp, "plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(data), "utf8");
  writeFileSync(path.join(dir, "index.cjs"), "module.exports = {};", "utf8");
  return inspectPluginDir(dir);
}

describe("Schema 与 Loader 一致性", () => {
  it("合法纯数据：Schema 通过且 Loader 接受", () => {
    const result = validateManifestData(validInput);
    expect(result.ok).toBe(true);
    expect(inspectWithData(validInput).manifest).not.toBeNull();
  });

  it.each([
    ["未知 dep", { ...validInput, deps: ["nope"] }],
    ["缺失必填字段", { ...validInput, author: undefined }],
    ["字段类型错误", { ...validInput, defaultEnabled: "yes" }],
    ["未知顶层字段", { ...validInput, experimental: true }],
    ["非对象 manifest", "not-an-object"],
  ])("%s：Schema 拒绝且 Loader 拒绝", (_name, data) => {
    expect(validateManifestData(data).ok).toBe(false);
    expect(inspectWithData(data).manifest).toBeNull();
  });

  it("五项新能力均通过 Schema 枚举并可用于 deps", () => {
    for (const dep of ["secrets", "workspace", "conversations", "scheduler", "speech-input"]) {
      expect(validateManifestData({ ...validInput, deps: [dep] }).ok).toBe(true);
    }
    const inspected = inspectWithData({
      ...validInput,
      deps: ["secrets", "conversations", "speech-input"],
    });
    expect(inspected.manifest?.deps).toEqual(["secrets", "conversations", "speech-input"]);
  });

  it("Schema 只管结构：格式问题（SemVer）由 Loader 补充拒绝", () => {
    const badVersion = { ...validInput, version: "latest" };
    expect(validateManifestData(badVersion).ok).toBe(true);
    expect(inspectWithData(badVersion).manifest).toBeNull();
  });
});
