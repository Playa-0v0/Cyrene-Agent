import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ingestOneFile,
  walkDir,
  ingestPaths,
  isBinary,
  isTextExt,
  isUnsupportedExt,
  SMALL_THRESHOLD,
  type Attachment,
  type ImportFn,
} from "./file-ingest";

// ── Helper: 臨時目錄 ──
let tmpDir: string;
function fixture(...segments: string[]): string {
  return path.join(tmpDir, ...segments);
}
function write(name: string, content: Buffer | string): string {
  const fp = fixture(name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  if (typeof content === "string") fs.writeFileSync(fp, content, "utf-8");
  else fs.writeFileSync(fp, content);
  return fp;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-ingest-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── isBinary ──
describe("isBinary", () => {
  it("普通文本 → false", () => {
    expect(isBinary(Buffer.from("hello world"))).toBe(false);
  });
  it("含 null 字節 → true", () => {
    expect(isBinary(Buffer.from([0x00, 0x48, 0x69]))).toBe(true);
  });
  it("空 buffer → false", () => {
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });
  it("純 null 字節 → true", () => {
    expect(isBinary(Buffer.alloc(10, 0x00))).toBe(true);
  });
  it("只含第一個 null → true", () => {
    expect(isBinary(Buffer.from([0x48, 0x00, 0x69]))).toBe(true);
  });
});

// ── isTextExt / isUnsupportedExt ──
describe("擴展名判斷", () => {
  it("isTextExt true", () => {
    expect(isTextExt(".txt")).toBe(true);
    expect(isTextExt(".md")).toBe(true);
    expect(isTextExt(".ts")).toBe(true);
    expect(isTextExt(".py")).toBe(true);
    expect(isTextExt(".json")).toBe(true);
    expect(isTextExt(".svg")).toBe(true);
  });
  it("isTextExt false（無擴展名/zip）", () => {
    expect(isTextExt("")).toBe(false);
    expect(isTextExt(".zip")).toBe(false);
  });
  it("isUnsupportedExt true", () => {
    expect(isUnsupportedExt(".zip")).toBe(true);
    expect(isUnsupportedExt(".pdf")).toBe(true);
    expect(isUnsupportedExt(".png")).toBe(true);
    expect(isUnsupportedExt(".exe")).toBe(true);
  });
  it("isUnsupportedExt false", () => {
    expect(isUnsupportedExt(".txt")).toBe(false);
    expect(isUnsupportedExt(".md")).toBe(false);
    expect(isUnsupportedExt("")).toBe(false);
    expect(isUnsupportedExt(".unknown")).toBe(false);
  });
});

// ── ingestOneFile ──
describe("ingestOneFile", () => {
  let mockImport: ImportFn;

  beforeEach(() => {
    mockImport = vi.fn().mockResolvedValue(3);
  });

  it("小文本文件 → kind:text 內容返回", async () => {
    const fp = write("hello.txt", "Hello, 世界！");
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.text).toBe("Hello, 世界！");
    }
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("大文本文件（>30k） → kind:indexed 調用 importFn", async () => {
    const big = "x".repeat(SMALL_THRESHOLD + 1);
    const fp = write("big.txt", big);
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("indexed");
    if (r.kind === "indexed") {
      expect(r.chunks).toBe(3);
    }
    expect(mockImport).toHaveBeenCalledOnce();
    expect(mockImport).toHaveBeenCalledWith(big, "big.txt");
  });

  it("正好等於閾值 → kind:indexed（含邊界）", async () => {
    const exact = "x".repeat(SMALL_THRESHOLD);
    const fp = write("exact.txt", exact);
    const r = await ingestOneFile(fp, mockImport);
    // > threshold 才索引，== threshold 應算小（<=）
    expect(r.kind).toBe("text");
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("空文件 → kind:empty", async () => {
    const fp = write("empty.txt", "");
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("empty");
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("僅空白字符 → kind:empty", async () => {
    const fp = write("spaces.txt", "   \n\t  ");
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("empty");
  });

  it("壓縮包 (.zip) → kind:unsupported", async () => {
    const fp = write("archive.zip", makeBin(100));
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") {
      expect(r.reason).toBe("暫不支持的文件格式 .zip（MVP-0 僅支持文本）");
    }
  });

  it("圖片 (.png) → kind:unsupported", async () => {
    const fp = write("img.png", makeBin(100));
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("unsupported");
  });

  it("無擴展名、二進制（含 null 字節） → unsupported", async () => {
    const fp = write("noext", Buffer.from([0x00, ...makeBin(99)])); // 頭字節是 0x00
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("unsupported");
  });

  it("無擴展名、文本 → text", async () => {
    const fp = write("readme", "This is my readme.");
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("text");
  });

  it("文本擴展名但含 null 字節 → unsupported（二進制兜底）", async () => {
    const fp = write("corrupt.txt", Buffer.from([0x48, 0x00, 0x69]));
    const r = await ingestOneFile(fp, mockImport);
    expect(r.kind).toBe("unsupported");
  });

  it("importFn 拋錯 → kind:indexed 但 chunks:0 不阻塞", async () => {
    const mockFailing = vi.fn().mockRejectedValue(new Error("embedding failed"));
    const big = "x".repeat(SMALL_THRESHOLD + 1);
    const fp = write("bad.txt", big);
    const r = await ingestOneFile(fp, mockFailing);
    expect(r.kind).toBe("indexed");
    if (r.kind === "indexed") {
      expect(r.chunks).toBe(0);
      expect(r.reason).toContain("embedding failed");
    }
  });

  it("文件不存在 → unsupported", async () => {
    const r = await ingestOneFile(fixture("nonexistent.txt"), mockImport);
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") expect(r.reason).toContain("ENOENT");
  });
});

// ── walkDir ──
describe("walkDir", () => {
  it("空目錄 → []", () => {
    const empty = fixture("empty");
    fs.mkdirSync(empty, { recursive: true });
    expect(walkDir(empty)).toEqual([]);
  });

  it("含多個文件 → 返回路徑列表（相對化？）", () => {
    write("a.txt", "a");
    write("b.md", "b");
    write("c.ts", "c");
    const r = walkDir(tmpDir).map((f) => path.relative(tmpDir, f));
    expect(r).toContain("a.txt");
    expect(r).toContain("b.md");
    expect(r).toContain("c.ts");
  });

  it("嵌套目錄 → 遞歸返回", () => {
    write("sub/a.md", "a");
    write("sub/deep/b.txt", "b");
    const r = walkDir(tmpDir).map((f) => path.relative(tmpDir, f).replace(/\\/g, "/"));
    expect(r).toContain("sub/a.md");
    expect(r).toContain("sub/deep/b.txt");
  });

  it("跳過隱藏文件（. 開頭）", () => {
    write(".hidden", "secret");
    write("visible.txt", "hello");
    const r = walkDir(tmpDir).map((f) => path.relative(tmpDir, f));
    expect(r).not.toContain(".hidden");
    expect(r).toContain("visible.txt");
  });

  it("跳過無權限目錄（graceful）", () => {
    // 不可能跨平臺可靠製造無權限目錄，只驗證不拋
    write("ok.txt", "ok");
    expect(() => walkDir(tmpDir)).not.toThrow();
  });
});

// ── ingestPaths ──
describe("ingestPaths", () => {
  let mockImport: ImportFn;
  beforeEach(() => {
    mockImport = vi.fn().mockResolvedValue(2);
  });

  it("單個文件 → [Attachment]", async () => {
    const fp = write("single.txt", "hello");
    const r = await ingestPaths([fp], mockImport);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("text");
    expect(r[0].name).toBe("single.txt");
  });

  it("目錄 → 遞歸所有文件", async () => {
    write("a.txt", "small");
    write("sub/b.md", "also small");
    const r = await ingestPaths([tmpDir], mockImport);
    expect(r).toHaveLength(2);
    const names = r.map((a) => a.name.replace(/\\/g, "/"));
    expect(names).toContain("a.txt");
    expect(names).toContain("sub/b.md");
  });

  it("混合輸入（文件+目錄+二進制）", async () => {
    const fp = write("notes.txt", "some text");
    write("sub/img.png", makeBin(100));
    write("sub/code.js", "const x = 1;");
    const r = await ingestPaths([fp, tmpDir], mockImport);
    expect(r).toHaveLength(3);
    expect(r.filter((a) => a.kind === "text")).toHaveLength(2);
    expect(r.filter((a) => a.kind === "unsupported")).toHaveLength(1);
  });

  it("不存在路徑 → 跳過不拋", async () => {
    const r = await ingestPaths([fixture("nope.txt"), fixture("alsonope")], mockImport);
    expect(r).toHaveLength(0);
  });

  it("路徑重複 → 去重", async () => {
    const fp = write("dedup.txt", "once");
    const r = await ingestPaths([fp, fp, fp], mockImport);
    expect(r).toHaveLength(1);
  });
});

// ── 工具 ──
function makeBin(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i + 0x80) & 0xff; // >127，非 ASCII
  // 頭 4KB 不含 null（模擬真實二進制文件）
  for (let i = 0; i < size && i < 4096; i++) {
    if (b[i] === 0) b[i] = 0xff;
  }
  return b;
}