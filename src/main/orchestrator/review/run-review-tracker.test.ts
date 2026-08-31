import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunReviewTracker } from "./run-review-tracker";
import type { ReviewSnapshot, ReviewLine, ReviewFileChange } from "../../../shared/review-types";

// 测试用临时目录,每个 case 独立隔离
let tmpRoot: string;
let tracker: RunReviewTracker;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-review-test-"));
  tracker = new RunReviewTracker(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("RunReviewTracker.captureBefore", () => {
  it("第一次修改文本文件:存 content + 写 journal capture 事件", () => {
    const filePath = path.join(tmpRoot, "src", "foo.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");

    tracker.captureBefore("run-1", filePath, "src/foo.ts");

    // before/<hash> 存在,内容是原始文件
    const journal = tracker.readJournal("run-1");
    expect(journal).toHaveLength(1);
    const event = journal[0];
    expect(event.type).toBe("capture");
    if (event.type === "capture") {
      expect(event.exists).toBe(true);
      expect(event.fileKind).toBe("text");
      expect(event.size).toBe(18);
      expect(event.displayPath).toBe("src/foo.ts");
      expect(event.contentHash).toBeTruthy();
    }

    // readBeforeContent 能读回内容
    if (event.type === "capture") {
      const content = tracker.readBeforeContent("run-1", event.hash);
      expect(content).toBe("line1\nline2\nline3\n");
    }
  });

  it("同一文件第二次 capture:跳过(惰性快照)", () => {
    const filePath = path.join(tmpRoot, "foo.ts");
    fs.writeFileSync(filePath, "original", "utf8");

    tracker.captureBefore("run-1", filePath, "foo.ts");
    // 修改文件
    fs.writeFileSync(filePath, "changed", "utf8");
    // 第二次 capture(不应更新 baseline)
    tracker.captureBefore("run-1", filePath, "foo.ts");

    const journal = tracker.readJournal("run-1");
    expect(journal).toHaveLength(1); // 只有一条 capture 事件

    // baseline 仍是原始内容
    if (journal[0].type === "capture") {
      expect(tracker.readBeforeContent("run-1", journal[0].hash)).toBe("original");
    }
  });

  it("不存在的文件:写 .absent 标记,exists=false", () => {
    const filePath = path.join(tmpRoot, "new-file.ts");

    tracker.captureBefore("run-1", filePath, "new-file.ts");

    const journal = tracker.readJournal("run-1");
    expect(journal).toHaveLength(1);
    if (journal[0].type === "capture") {
      expect(journal[0].exists).toBe(false);
      expect(tracker.readBeforeContent("run-1", journal[0].hash)).toBeNull();
    }
  });

  it("二进制文件(含 null byte):写 .binary 标记,不存 content", () => {
    const filePath = path.join(tmpRoot, "model.bin");
    // 写含 null byte 的内容
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]);
    fs.writeFileSync(filePath, binaryContent);

    tracker.captureBefore("run-1", filePath, "model.bin");

    const journal = tracker.readJournal("run-1");
    expect(journal).toHaveLength(1);
    if (journal[0].type === "capture") {
      expect(journal[0].exists).toBe(true);
      expect(journal[0].fileKind).toBe("binary");
      expect(tracker.readBeforeContent("run-1", journal[0].hash)).toBeNull();
    }
  });

  it("不同 Run 独立:同一文件在 run-1 和 run-2 各自 capture", () => {
    const filePath = path.join(tmpRoot, "shared.ts");
    fs.writeFileSync(filePath, "v1", "utf8");

    tracker.captureBefore("run-1", filePath, "shared.ts");
    fs.writeFileSync(filePath, "v2", "utf8");
    tracker.captureBefore("run-2", filePath, "shared.ts");

    const journal1 = tracker.readJournal("run-1");
    const journal2 = tracker.readJournal("run-2");
    expect(journal1).toHaveLength(1);
    expect(journal2).toHaveLength(1);

    // run-1 baseline = v1,run-2 baseline = v2
    if (journal1[0].type === "capture" && journal2[0].type === "capture") {
      expect(tracker.readBeforeContent("run-1", journal1[0].hash)).toBe("v1");
      expect(tracker.readBeforeContent("run-2", journal2[0].hash)).toBe("v2");
    }
  });
});

describe("RunReviewTracker.recordRename", () => {
  it("记录 rename 事件到 journal", () => {
    tracker.recordRename("run-1", "/old/path.ts", "/new/path.ts", "old/path.ts", "new/path.ts");

    const journal = tracker.readJournal("run-1");
    expect(journal).toHaveLength(1);
    if (journal[0].type === "rename") {
      expect(journal[0].fromAbsPath).toBe(path.resolve("/old/path.ts"));
      expect(journal[0].toAbsPath).toBe(path.resolve("/new/path.ts"));
      expect(journal[0].fromDisplayPath).toBe("old/path.ts");
      expect(journal[0].toDisplayPath).toBe("new/path.ts");
    }
  });
});

describe("RunReviewTracker.hasReviewData", () => {
  it("无 journal 时返回 false", () => {
    expect(tracker.hasReviewData("run-empty")).toBe(false);
  });

  it("有 capture 事件时返回 true", () => {
    const filePath = path.join(tmpRoot, "foo.ts");
    fs.writeFileSync(filePath, "content", "utf8");
    tracker.captureBefore("run-1", filePath, "foo.ts");
    expect(tracker.hasReviewData("run-1")).toBe(true);
  });
});

describe("RunReviewTracker journal 健壮性", () => {
  it("跳过损坏的 JSON 行", () => {
    const journalPath = path.join(tmpRoot, "cyrene-runs", "reviews", "run-1", "journal.jsonl");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    // 写一行合法 + 一行损坏 + 一行合法
    fs.writeFileSync(
      journalPath,
      '{"type":"capture","absPath":"/a","displayPath":"a","hash":"h1","exists":false,"fileKind":"text","size":0,"contentHash":"","capturedAt":1}\n' +
        "{ broken json\n" +
        '{"type":"capture","absPath":"/b","displayPath":"b","hash":"h2","exists":false,"fileKind":"text","size":0,"contentHash":"","capturedAt":2}\n',
      "utf8",
    );

    const journal = tracker.readJournal("run-1");
    expect(journal).toHaveLength(2); // 跳过损坏行
    if (journal[0].type === "capture") {
      expect(journal[0].absPath).toBe("/a");
    }
  });
});

describe("RunReviewTracker.finalizeReview", () => {
  it("修改文件:kind=modified + diff hunks 有正确的行号和类型", () => {
    const filePath = path.join(tmpRoot, "foo.ts");
    fs.writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");
    tracker.captureBefore("run-1", filePath, "foo.ts");

    // 修改文件
    fs.writeFileSync(filePath, "line1\nchanged\nline3\n", "utf8");

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0];
    expect(file.kind).toBe("modified");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toBeDefined();
    expect(file.hunks!.length).toBeGreaterThan(0);

    // 验证 diff 行的类型和行号
    const lines = file.hunks![0].lines;
    const addLine = lines.find((l: ReviewLine) => l.type === "add");
    const removeLine = lines.find((l: ReviewLine) => l.type === "remove");
    expect(addLine).toBeDefined();
    expect(removeLine).toBeDefined();
    expect(addLine!.oldLine).toBeNull();
    expect(addLine!.newLine).toBe(2);
    expect(removeLine!.oldLine).toBe(2);
    expect(removeLine!.newLine).toBeNull();
    expect(addLine!.text).toBe("changed");
    expect(removeLine!.text).toBe("line2");
  });

  it("新建文件:kind=created + 整文件 add", () => {
    const filePath = path.join(tmpRoot, "new.ts");
    tracker.captureBefore("run-1", filePath, "new.ts"); // 文件不存在

    // 创建文件
    fs.writeFileSync(filePath, "new1\nnew2\n", "utf8");

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0];
    expect(file.kind).toBe("created");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.hunks).toBeDefined();
    expect(file.hunks![0].lines).toHaveLength(2);
    expect(file.hunks![0].lines.every((l: ReviewLine) => l.type === "add")).toBe(true);
    expect(file.hunks![0].lines[0].newLine).toBe(1);
    expect(file.hunks![0].lines[1].newLine).toBe(2);
  });

  it("删除文件:kind=deleted + 整文件 remove", () => {
    const filePath = path.join(tmpRoot, "old.ts");
    fs.writeFileSync(filePath, "old1\nold2\n", "utf8");
    tracker.captureBefore("run-1", filePath, "old.ts");

    // 删除文件
    fs.unlinkSync(filePath);

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0];
    expect(file.kind).toBe("deleted");
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(2);
    expect(file.hunks).toBeDefined();
    expect(file.hunks![0].lines.every((l: ReviewLine) => l.type === "remove")).toBe(true);
  });

  it("内容没变:跳过,不生成 ReviewFileChange", () => {
    const filePath = path.join(tmpRoot, "unchanged.ts");
    fs.writeFileSync(filePath, "same\n", "utf8");
    tracker.captureBefore("run-1", filePath, "unchanged.ts");

    // 不修改文件
    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).toBeNull(); // 所有文件都没变 → null
  });

  it("无 journal:返回 null", () => {
    const snapshot = tracker.finalizeReview("run-empty", Date.now() - 1000, "completed");
    expect(snapshot).toBeNull();
  });

  it("loadReview:能读回已生成的 snapshot", () => {
    const filePath = path.join(tmpRoot, "foo.ts");
    fs.writeFileSync(filePath, "original\n", "utf8");
    tracker.captureBefore("run-1", filePath, "foo.ts");
    fs.writeFileSync(filePath, "changed\n", "utf8");

    tracker.finalizeReview("run-1", 1000, "completed");

    const loaded = tracker.loadReview("run-1");
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.runId).toBe("run-1");
    expect(loaded.startedAt).toBe(1000);
    expect(loaded.status).toBe("completed");
    expect(loaded.files).toHaveLength(1);
    expect(loaded.files[0].kind).toBe("modified");
  });

  it("rename:kind=renamed,内容没变时 additions=0/deletions=0", () => {
    const fromPath = path.join(tmpRoot, "old-name.ts");
    const toPath = path.join(tmpRoot, "new-name.ts");
    fs.writeFileSync(fromPath, "content\n", "utf8");
    tracker.captureBefore("run-1", fromPath, "old-name.ts");
    tracker.recordRename("run-1", fromPath, toPath, "old-name.ts", "new-name.ts");

    // 执行 rename
    fs.renameSync(fromPath, toPath);

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0];
    expect(file.kind).toBe("renamed");
    expect(file.oldPath).toBe("old-name.ts");
    expect(file.newPath).toBe("new-name.ts");
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it("rename + 修改:kind=renamed + 有 diff", () => {
    const fromPath = path.join(tmpRoot, "old.ts");
    const toPath = path.join(tmpRoot, "new.ts");
    fs.writeFileSync(fromPath, "line1\nline2\n", "utf8");
    tracker.captureBefore("run-1", fromPath, "old.ts");
    tracker.recordRename("run-1", fromPath, toPath, "old.ts", "new.ts");

    // rename + 修改
    fs.renameSync(fromPath, toPath);
    fs.writeFileSync(toPath, "line1\nchanged\n", "utf8");

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0];
    expect(file.kind).toBe("renamed");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it("binary 文件:kind=binary,只存 metadata 不生成 hunks", () => {
    const filePath = path.join(tmpRoot, "model.bin");
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    tracker.captureBefore("run-1", filePath, "model.bin");

    // 修改 binary 文件
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x04]));

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0];
    expect(file.kind).toBe("binary");
    expect(file.hunks).toBeUndefined();
    expect(file.before).toBeDefined();
    expect(file.after).toBeDefined();
    expect(file.before!.size).toBe(5);
    expect(file.after!.size).toBe(5);
  });

  it("多文件变更:一个 modified + 一个 created", () => {
    const modFile = path.join(tmpRoot, "modified.ts");
    const newFile = path.join(tmpRoot, "created.ts");
    fs.writeFileSync(modFile, "original\n", "utf8");

    tracker.captureBefore("run-1", modFile, "modified.ts");
    tracker.captureBefore("run-1", newFile, "created.ts");

    fs.writeFileSync(modFile, "changed\n", "utf8");
    fs.writeFileSync(newFile, "new\n", "utf8");

    const snapshot = tracker.finalizeReview("run-1", Date.now() - 1000, "completed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.files).toHaveLength(2);
    const kinds = snapshot.files.map((f: ReviewFileChange) => f.kind).sort();
    expect(kinds).toEqual(["created", "modified"]);
  });

  it("snapshot 含正确的 runId/startedAt/status", () => {
    const filePath = path.join(tmpRoot, "foo.ts");
    fs.writeFileSync(filePath, "a\n", "utf8");
    tracker.captureBefore("run-1", filePath, "foo.ts");
    fs.writeFileSync(filePath, "b\n", "utf8");

    const snapshot: ReviewSnapshot | null = tracker.finalizeReview("run-1", 12345, "failed");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    expect(snapshot.runId).toBe("run-1");
    expect(snapshot.startedAt).toBe(12345);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.endedAt).toBeGreaterThan(12345);
  });
});

describe("RunReviewTracker.finalizeIfPending", () => {
  it("已 finalize 的 Run:直接返回缓存,不重复生成", () => {
    const filePath = path.join(tmpRoot, "foo.ts");
    fs.writeFileSync(filePath, "original\n", "utf8");
    tracker.captureBefore("run-1", filePath, "foo.ts");
    fs.writeFileSync(filePath, "modified\n", "utf8");

    // 第一次 finalize
    const first = tracker.finalizeReview("run-1", 1000, "completed");
    expect(first).not.toBeNull();

    // finalizeIfPending 应直接返回缓存（不重新读文件）
    const cached = tracker.finalizeIfPending("run-1", 1000, "halted");
    expect(cached).not.toBeNull();
    expect(cached!.status).toBe("completed"); // 保持第一次的状态
    expect(cached!.startedAt).toBe(1000);
  });

  it("未 finalize 但有 journal 数据:按给定状态补生成（崩溃恢复场景）", () => {
    const filePath = path.join(tmpRoot, "bar.ts");
    fs.writeFileSync(filePath, "v1\n", "utf8");
    tracker.captureBefore("run-crash", filePath, "bar.ts");
    fs.writeFileSync(filePath, "v2\n", "utf8");

    // 模拟崩溃：未调用 finalizeReview，直接用 finalizeIfPending 补生成
    const snapshot = tracker.finalizeIfPending("run-crash", 5000, "halted");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    expect(snapshot.status).toBe("halted");
    expect(snapshot.startedAt).toBe(5000);
    expect(snapshot.files[0].kind).toBe("modified");
  });

  it("无 journal 数据:返回 null", () => {
    const snapshot = tracker.finalizeIfPending("run-empty", 0, "halted");
    expect(snapshot).toBeNull();
  });
});
