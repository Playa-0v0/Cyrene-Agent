import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { commitPreparedPlugin, discardPreparedPlugin, preparePluginZip } from "./installer";

interface ZipEntry {
  name: string;
  data: string;
  mode?: number;
  method?: 0 | 8;
  declaredUncompressedSize?: number;
}
let tmp = "";

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(file: string, entries: ZipEntry[]): void {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...localParts, ...centralParts, end]));
}

function manifest(id = "zip-demo", version = "1.0.0"): string {
  return JSON.stringify({
    apiVersion: 1,
    id,
    name: "ZIP Demo",
    version,
    description: "demo",
    author: "tester",
    entry: "index.cjs",
  });
}

function setup(): { root: string; zip: string } {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-plugin-zip-"));
  return { root: path.join(tmp, "plugins"), zip: path.join(tmp, "plugin.zip") };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

describe("plugin ZIP installer", () => {
  it("accepts one wrapped plugin directory and commits it by manifest id", async () => {
    const { root, zip } = setup();
    createZip(zip, [
      { name: "release/manifest.json", data: manifest() },
      { name: "release/index.cjs", data: "module.exports={register(){}}" },
    ]);
    const prepared = await preparePluginZip(zip, root);
    expect(prepared.manifest.id).toBe("zip-demo");

    const installed = await commitPreparedPlugin(prepared, root, false);

    expect(installed).toBe(path.join(root, "zip-demo"));
    expect(readFileSync(path.join(installed, "manifest.json"), "utf8")).toContain("zip-demo");
    expect(existsSync(prepared.stagingDir)).toBe(false);
  });

  it("accepts a plugin whose manifest is at the ZIP root", async () => {
    const { root, zip } = setup();
    createZip(zip, [
      { name: "manifest.json", data: manifest("root-demo") },
      { name: "index.cjs", data: "module.exports={register(){}}" },
    ]);
    const prepared = await preparePluginZip(zip, root);
    expect(prepared.manifest.id).toBe("root-demo");
    await discardPreparedPlugin(prepared);
  });

  it("rejects traversal entries and removes all staging data", async () => {
    const { root, zip } = setup();
    createZip(zip, [
      { name: "../escaped.txt", data: "unsafe" },
      { name: "manifest.json", data: manifest() },
      { name: "index.cjs", data: "module.exports={register(){}}" },
    ]);

    await expect(preparePluginZip(zip, root)).rejects.toThrow(/bound|不安全路径|invalid relative path/i);
    expect(existsSync(path.join(tmp, "escaped.txt"))).toBe(false);
  });

  it("rejects symbolic links from Unix ZIP metadata", async () => {
    const { root, zip } = setup();
    createZip(zip, [
      { name: "manifest.json", data: manifest() },
      { name: "index.cjs", data: "module.exports={register(){}}" },
      { name: "link", data: "../outside", mode: 0o120777 },
    ]);
    await expect(preparePluginZip(zip, root)).rejects.toThrow("不允许包含符号链接");
  });

  it("rejects case-colliding paths before Windows can overwrite either entry", async () => {
    const { root, zip } = setup();
    createZip(zip, [
      { name: "manifest.json", data: manifest() },
      { name: "MANIFEST.JSON", data: manifest("other") },
      { name: "index.cjs", data: "module.exports={register(){}}" },
    ]);
    await expect(preparePluginZip(zip, root)).rejects.toThrow("大小写冲突路径");
  });

  it("rejects a ZIP entry whose declared expanded size exceeds the per-file limit", async () => {
    const { root, zip } = setup();
    createZip(zip, [{
      name: "oversized.bin",
      data: "small payload",
      method: 8,
      declaredUncompressedSize: 51 * 1024 * 1024,
    }]);
    await expect(preparePluginZip(zip, root)).rejects.toThrow("单文件解压后超过 50 MiB");
  });

  it("rejects an invalid manifest before touching an existing installation", async () => {
    const { root, zip } = setup();
    createZip(zip, [
      { name: "manifest.json", data: manifest("Bad ID") },
      { name: "index.cjs", data: "module.exports={register(){}}" },
    ]);
    await expect(preparePluginZip(zip, root)).rejects.toThrow("id 不符合小写连字符格式");
  });

  it("replaces an existing program atomically while preserving files outside it", async () => {
    const { root, zip } = setup();
    const existing = path.join(root, "zip-demo");
    const data = path.join(tmp, "plugin-data", "zip-demo.json");
    mkdirSync(path.dirname(data), { recursive: true });
    writeFileSync(data, "keep", { encoding: "utf8", flag: "w" });
    createZip(zip, [
      { name: "manifest.json", data: manifest("zip-demo", "2.0.0") },
      { name: "index.cjs", data: "module.exports={register(){return 'new'}}" },
    ]);
    const first = await preparePluginZip(zip, root);
    await commitPreparedPlugin(first, root, false);
    writeFileSync(path.join(existing, "old.txt"), "old");
    const second = await preparePluginZip(zip, root);

    await commitPreparedPlugin(second, root, true);

    expect(existsSync(path.join(existing, "old.txt"))).toBe(false);
    expect(readFileSync(data, "utf8")).toBe("keep");
  });
});
