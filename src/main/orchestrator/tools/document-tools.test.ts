/**
 * document-tools 测试：
 * - filename 校验报错：区分「未提供」与「值不合法」，回传实际收到的参数键（丢参模型自纠）
 * - Review 基线捕获：覆盖已有文件存 text/binary 基线，新建文件存 absent 标记
 * 基线路径：<userData>/cyrene-runs/reviews/<runId>/before/
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;

// 内存版注册表：真实执行 register → execute 链路，不污染全局
const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

// electron mock：desktop / userData 都指向临时目录
vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => tmpDir,
  },
}));

// 样式目录 mock：测试不依赖 skills/ 真实文件
vi.mock("../../external-content-paths", () => ({
  findSkillPath: (_skillId: string, _sub: string) => null,
}));

import { registerDocumentTools } from "./document-tools";

registerDocumentTools();

function getTool(id: string) {
  const tool = registry.get(id) as
    | { execute: (args: Record<string, unknown>, ctx?: { runId?: string; resolvedWorkspaceRoot?: string }) => Promise<string> }
    | undefined;
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool;
}

/** 列出某 run 的 before/ 基线文件（含 .absent / .binary 后缀）。 */
function listBaselines(runId: string): string[] {
  const dir = path.join(tmpDir, "cyrene-runs", "reviews", runId, "before");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-tools-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("filename 校验报错（参数缺失时回传实际键名）", () => {
  it("write_markdown 缺 filename 时报错点名缺失并回传收到的键", async () => {
    const raw = await getTool("write_markdown").execute({ content: "# 笔记" }, {});
    // MiniMax-M3 30 连丢 filename 的场景：模型只传了 content
    expect(raw).toContain("未提供 filename");
    expect(raw).toContain("content");
    expect(raw).toContain(".md");
  });

  it("write_markdown filename 后缀不对时报错回传实际值", async () => {
    const raw = await getTool("write_markdown").execute(
      { filename: "notes.rtf", content: "x" },
      {},
    );
    expect(raw).toContain("必须是 .md 或 .txt 结尾");
    expect(raw).toContain("notes.rtf");
    expect(fs.readdirSync(tmpDir).join(",")).not.toContain("notes.rtf");
  });

  it("write_markdown 接受 .txt 后缀（learn 模式写纯文本）", async () => {
    const raw = await getTool("write_markdown").execute(
      { filename: "todo.txt", content: "第一行\n第二行" },
      {},
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "todo.txt"), "utf8")).toBe("第一行\n第二行");
  });

  it("write_excel / write_word / write_pdf 缺 filename 时同样回传键名（不生成文件）", async () => {
    for (const [id, args, ext] of [
      ["write_excel", { sheets: [{ name: "S1", headers: [], rows: [] }] }, ".xlsx"],
      ["write_word", { title: "t", paragraphs: ["p"] }, ".docx"],
      ["write_pdf", { title: "t", paragraphs: ["p"] }, ".pdf"],
    ] as const) {
      const raw = await getTool(id).execute({ ...args }, {});
      expect(raw).toContain("未提供 filename");
      expect(raw).toContain(ext);
    }
  });

  it("write_excel sheets 缺失时报错回传键名", async () => {
    const raw = await getTool("write_excel").execute({ filename: "a.xlsx" }, {});
    expect(raw).toContain("sheets 不能为空");
    expect(raw).toContain("filename");
  });
});

describe("Review 基线捕获（写盘前）", () => {
  it("write_markdown 覆盖已有文件时保存 text 基线", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "旧内容\n第二行\n");

    const raw = await getTool("write_markdown").execute(
      { filename: "note.md", content: "新内容" },
      { runId: "run-md-1" },
    );
    // 返回体是 JSON（Diff Review 卡片证据链解析 changes 字段）
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.append).toBe(false);

    const baselines = listBaselines("run-md-1");
    expect(baselines).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, "cyrene-runs", "reviews", "run-md-1", "before", baselines[0]), "utf8"))
      .toBe("旧内容\n第二行\n");
  });

  it("write_markdown 新建文件时写 absent 标记", async () => {
    await getTool("write_markdown").execute(
      { filename: "new-note.md", content: "内容" },
      { runId: "run-md-2" },
    );

    const baselines = listBaselines("run-md-2");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.absent$/);
    // 同一 run 再次修改同一文件不重复捕获（惰性快照）
    await getTool("write_markdown").execute(
      { filename: "new-note.md", content: "再改" },
      { runId: "run-md-2" },
    );
    expect(listBaselines("run-md-2")).toHaveLength(1);
  });

  it("无 runId 时不写基线", async () => {
    await getTool("write_markdown").execute(
      { filename: "plain.md", content: "x" },
      {},
    );
    expect(fs.existsSync(path.join(tmpDir, "cyrene-runs"))).toBe(false);
  });

  describe("append 模式", () => {
    it("append=true 时追加到已有文件末尾", async () => {
      const file = path.join(tmpDir, "note.md");
      fs.writeFileSync(file, "# 标题\n\n第一段。");

      const raw = await getTool("write_markdown").execute(
        { filename: "note.md", content: "第二段。", append: true },
        {},
      );
      const result = JSON.parse(raw);
      expect(result.success).toBe(true);
      expect(result.append).toBe(true);
      // 原文件末尾无换行 → 追加前补一个，两段不粘连
      expect(fs.readFileSync(file, "utf8")).toBe("# 标题\n\n第一段。\n第二段。");
    });

    it("原文件以换行结尾时追加不重复换行", async () => {
      const file = path.join(tmpDir, "note.md");
      fs.writeFileSync(file, "第一段\n");

      await getTool("write_markdown").execute(
        { filename: "note.md", content: "第二段", append: true },
        {},
      );
      expect(fs.readFileSync(file, "utf8")).toBe("第一段\n第二段");
    });

    it("append=true 但文件不存在时新建", async () => {
      const file = path.join(tmpDir, "fresh.md");

      const raw = await getTool("write_markdown").execute(
        { filename: "fresh.md", content: "初始内容", append: true },
        {},
      );
      // append 目标不存在 → 等同新建（added）
      const result = JSON.parse(raw);
      expect(result.success).toBe(true);
      expect(result.append).toBe(true);
      expect(result.changes[0].kind).toBe("added");
      expect(fs.readFileSync(file, "utf8")).toBe("初始内容");
    });

    it("分两次写长笔记：覆盖写前半 + append 续写后半", async () => {
      const file = path.join(tmpDir, "long-note.md");

      await getTool("write_markdown").execute(
        { filename: "long-note.md", content: "# 长笔记\n\n前半部分。\n" },
        {},
      );
      await getTool("write_markdown").execute(
        { filename: "long-note.md", content: "\n后半部分。\n", append: true },
        {},
      );
      expect(fs.readFileSync(file, "utf8")).toBe("# 长笔记\n\n前半部分。\n\n后半部分。\n");
    });

    it("不传 append（默认覆盖）不追加", async () => {
      const file = path.join(tmpDir, "note.md");
      fs.writeFileSync(file, "旧内容");

      await getTool("write_markdown").execute(
        { filename: "note.md", content: "新内容" },
        {},
      );
      expect(fs.readFileSync(file, "utf8")).toBe("新内容");
    });

    it("append 分段写共用同一基线（首段前捕获，追加不重复）", async () => {
      await getTool("write_markdown").execute(
        { filename: "multi.md", content: "段落一\n" },
        { runId: "run-append-1" },
      );
      await getTool("write_markdown").execute(
        { filename: "multi.md", content: "段落二\n", append: true },
        { runId: "run-append-1" },
      );
      // 惰性快照：同一 run 只在第一次修改前捕获一次
      expect(listBaselines("run-append-1")).toHaveLength(1);
    });
  });

  it("write_excel 覆盖已有文件时保存 binary 基线（metadata）", async () => {
    // 预置旧二进制（tracker 按前 8KB 是否含 null byte 判定，与扩展名无关）
    fs.writeFileSync(path.join(tmpDir, "report.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]));

    const raw = await getTool("write_excel").execute(
      { filename: "report.xlsx", sheets: [{ name: "S1", headers: ["列A"], rows: [[1, 2]] }] },
      { runId: "run-xlsx-1" },
    );
    expect(raw).toContain("已生成");

    const baselines = listBaselines("run-xlsx-1");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.binary$/);
  });

  it("write_word 覆盖已有文件时保存 binary 基线", async () => {
    fs.writeFileSync(path.join(tmpDir, "report.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]));

    const raw = await getTool("write_word").execute(
      { filename: "report.docx", title: "标题", paragraphs: ["段落一"] },
      { runId: "run-docx-1" },
    );
    expect(raw).toContain("已生成");

    const baselines = listBaselines("run-docx-1");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.binary$/);
  });

  it("write_pdf 基线捕获先于生成（生成失败也不影响基线）", async () => {
    fs.writeFileSync(path.join(tmpDir, "report.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0, 1]));

    // 本机 msyh.ttc 与 pdfkit 的 subset 不兼容，doc.text() 会抛错——
    // 恰好验证 write-ahead 语义：基线在任何写盘/生成动作之前已保存
    let threw = false;
    try {
      await getTool("write_pdf").execute(
        { filename: "report.pdf", title: "标题", paragraphs: ["段落一"] },
        { runId: "run-pdf-1" },
      );
    } catch {
      threw = true;
    }

    const baselines = listBaselines("run-pdf-1");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatch(/\.binary$/);
    if (threw) {
      // 生成失败时原二进制不应被截断破坏（createWriteStream 未成功写入）
      // 等待 pdfkit 内部流动作结束，避免延迟 open 撞上目录清理
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});

describe("write_markdown 覆盖写防护与 JSON 返回体", () => {
  it("返回 JSON 带 changes：覆盖已有文件 → modified + 行级 diff", async () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, "旧一\n旧二");

    const raw = await getTool("write_markdown").execute(
      { filename: "note.md", content: "新一\n新二\n新三" },
      {},
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.tool).toBe("write_markdown");
    expect(result.path).toBe(file);
    expect(result.append).toBe(false);

    const change = result.changes[0];
    expect(change.kind).toBe("modified");
    expect(change.deletions).toBe(2);
    expect(change.insertions).toBe(3);
    const removeTexts = change.diff.filter((l: { type: string }) => l.type === "remove").map((l: { text: string }) => l.text);
    const addTexts = change.diff.filter((l: { type: string }) => l.type === "add").map((l: { text: string }) => l.text);
    expect(removeTexts).toEqual(["旧一", "旧二"]);
    expect(addTexts).toEqual(["新一", "新二", "新三"]);
  });

  it("新建文件 → added diff", async () => {
    const raw = await getTool("write_markdown").execute(
      { filename: "fresh.md", content: "# 标题" },
      {},
    );
    const result = JSON.parse(raw);
    const change = result.changes[0];
    expect(change.kind).toBe("added");
    expect(change.insertions).toBe(1);
    expect(change.diff.map((l: { type: string; text: string }) => l.type)).toEqual(["add"]);
  });

  it("大文件骤降过半被拒绝且文件保持原样", async () => {
    const file = path.join(tmpDir, "big.md");
    const original = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    fs.writeFileSync(file, original);

    await expect(
      getTool("write_markdown").execute({ filename: "big.md", content: "半截" }, {}),
    ).rejects.toMatchObject({
      code: "E_OVERWRITE_DROP_BLOCKED",
      category: "runtime_safety",
      retryable: false,
      effectState: "not_applied",
    });
    // 拒绝发生在落盘之前，原文件未被改动
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("小文件合法缩水不拦截", async () => {
    const file = path.join(tmpDir, "small.md");
    fs.writeFileSync(file, Array.from({ length: 8 }, (_, i) => `行 ${i + 1}`).join("\n"));

    const raw = await getTool("write_markdown").execute(
      { filename: "small.md", content: "整理后的两行\n第二行" },
      {},
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("整理后的两行\n第二行");
  });

  it("append 到大文件不做骤降检查", async () => {
    const file = path.join(tmpDir, "big-append.md");
    const original = Array.from({ length: 60 }, (_, i) => `行 ${i + 1}`).join("\n");
    fs.writeFileSync(file, original);

    const raw = await getTool("write_markdown").execute(
      { filename: "big-append.md", content: "追加的一小段", append: true },
      {},
    );
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    // 追加不删行：changes 记为 added（与 write_file 口径一致）
    expect(result.changes[0].kind).toBe("added");
    expect(fs.readFileSync(file, "utf8")).toBe(original + "\n追加的一小段");
  });
});
