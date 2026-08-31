// apply_patch 工具 — Codex 风格的结构化文件编辑
//
// 支持操作：
// - Update File: 修改已有文件（上下文匹配 + 增删行），可选 Move to
// - Add File: 创建新文件
// - Delete File: 删除文件
//
// 安全约束：
// - 工作区根目录限制（路径逃逸检测）
// - 预验证全部 hunk 后再执行（事务语义：任一失败则全部不执行）
// - 保留原始 EOL（CRLF / LF）

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { toolRegistry } from "./tool-registry";
import type { ToolContext } from "./tool-context";
import type { ToolDiffLine, ToolFileChange } from "../../shared/chat-types";
import { buildFullFileDiff, finalizeFileChanges } from "./tool-evidence";
import { getRunReviewTracker } from "./review/run-review-tracker";

const LOG_PREFIX = "[ApplyPatch]";

// ── 类型 ──────────────────────────────────────────────────

interface UpdateChunkLine {
  type: "context" | "removal" | "addition";
  content: string;
}

type PatchHunk =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

interface UpdateChunk {
  /** 按出现顺序排列的行，保留 context/removal/addition 的相对位置 */
  lines: UpdateChunkLine[];
}

interface ParseResult {
  hunks: PatchHunk[];
  errors: string[];
}

interface ApplyResult {
  success: boolean;
  applied: string[];
  errors: string[];
  /** 前端 Diff Review 卡片渲染用结构化变更证据 */
  changes?: ToolFileChange[];
}

// ── 路径安全 ──────────────────────────────────────────────

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot, filePath);
  const normalizedRoot = path.normalize(workspaceRoot);
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
}

// ── EOL 检测 ──────────────────────────────────────────────

function detectEOL(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

// ── Parser ────────────────────────────────────────────────

export function parsePatch(patchText: string): ParseResult {
  // 去掉每行结尾的 \r：patch 文本若按 CRLF 传输，残留的 \r 会进入行内容导致匹配失败
  const lines = patchText.split("\n").map((l) => l.replace(/\r$/, ""));
  const hunks: PatchHunk[] = [];
  const errors: string[] = [];

  let i = 0;

  // 跳过直到 *** Begin Patch
  while (i < lines.length && lines[i].trim() !== "*** Begin Patch") {
    i++;
  }
  if (i >= lines.length) {
    return { hunks: [], errors: ["patch 必须以 *** Begin Patch 开头"] };
  }
  i++; // 跳过 *** Begin Patch

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "*** End Patch") break;

    // *** Update File: path
    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      i++;

      // 可选 *** Move to: newpath
      let movePath: string | undefined;
      if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
        movePath = lines[i].slice("*** Move to: ".length).trim();
        i++;
      }

      const chunks: UpdateChunk[] = [];
      let currentChunk: UpdateChunk | null = null;

      while (i < lines.length && !lines[i].startsWith("*** ")) {
        const patchLine = lines[i];

        if (patchLine.trim() === "@@") {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = { lines: [] };
          i++;
          continue;
        }

        if (!currentChunk) currentChunk = { lines: [] };

        if (patchLine.startsWith("+")) {
          currentChunk.lines.push({ type: "addition", content: patchLine.slice(1) });
        } else if (patchLine.startsWith("-")) {
          currentChunk.lines.push({ type: "removal", content: patchLine.slice(1) });
        } else if (patchLine.startsWith(" ")) {
          currentChunk.lines.push({ type: "context", content: patchLine.slice(1) });
        } else if (patchLine === "") {
          currentChunk.lines.push({ type: "context", content: "" });
        }
        i++;
      }

      if (currentChunk) chunks.push(currentChunk);

      if (chunks.length === 0) {
        errors.push(`${filePath}: Update File 不包含任何编辑块（缺少 @@ ... 内容）`);
      } else {
        hunks.push({ type: "update", path: filePath, ...(movePath ? { movePath } : {}), chunks });
      }
      continue;
    }

    // *** Add File: path
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      i++;

      const contentLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (lines[i].startsWith("+")) {
          contentLines.push(lines[i].slice(1));
        } else if (lines[i] === "") {
          contentLines.push("");
        }
        i++;
      }

      hunks.push({ type: "add", path: filePath, content: contentLines.join("\n") });
      continue;
    }

    // *** Delete File: path
    if (line.startsWith("*** Delete File: ")) {
      const filePath = line.slice("*** Delete File: ".length).trim();
      hunks.push({ type: "delete", path: filePath });
      i++;
      continue;
    }

    // 未知行，跳过
    i++;
  }

  return { hunks, errors };
}

// ── Matcher ───────────────────────────────────────────────

function findSequence(
  fileLines: string[],
  startSearch: number,
  pattern: string[],
): { start: number; end: number } | null {
  if (pattern.length === 0) return null;

  for (let i = startSearch; i <= fileLines.length - pattern.length; i++) {
    let matched = true;
    for (let j = 0; j < pattern.length; j++) {
      if (fileLines[i + j] !== pattern[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return { start: i, end: i + pattern.length };
  }
  return null;
}

function getPreImage(chunk: UpdateChunk): string[] {
  return chunk.lines.filter((l) => l.type !== "addition").map((l) => l.content);
}

function getPostImage(chunk: UpdateChunk): string[] {
  return chunk.lines.filter((l) => l.type !== "removal").map((l) => l.content);
}

function findChunkMatch(
  fileLines: string[],
  startSearch: number,
  chunk: UpdateChunk,
): { start: number; end: number } | null {
  const preImage = getPreImage(chunk);

  if (preImage.length === 0) {
    // 纯添加（无上下文、无删除）：在搜索起点插入
    return { start: startSearch, end: startSearch };
  }

  return findSequence(fileLines, startSearch, preImage);
}

function applyChunkToFile(
  fileLines: string[],
  chunk: UpdateChunk,
  searchStart: number,
): { lines: string[]; nextSearch: number; error?: string } {
  const match = findChunkMatch(fileLines, searchStart, chunk);
  if (!match) {
    const expected = getPreImage(chunk);
    return {
      lines: fileLines,
      nextSearch: fileLines.length,
      error: `未找到匹配的上下文。期望找到:\n${expected.map((l) => `  ${l}`).join("\n")}`,
    };
  }

  // 用 postImage 替换 preImage（保持 context 行，用 additions 替换 removals）
  const postImage = getPostImage(chunk);
  const before = fileLines.slice(0, match.start);
  const after = fileLines.slice(match.end);
  const newLines = [...before, ...postImage, ...after];

  return {
    lines: newLines,
    nextSearch: match.start + postImage.length,
  };
}

// ── Executor ──────────────────────────────────────────────

export function applyPatchHunks(hunks: PatchHunk[], workspaceRoot: string): ApplyResult {
  const applied: string[] = [];
  const errors: string[] = [];
  const changes: ToolFileChange[] = [];

  // ── 阶段 1：预验证全部 hunk ──
  for (const hunk of hunks) {
    const resolvedPath = path.resolve(workspaceRoot, hunk.path);

    if (!isWithinWorkspace(resolvedPath, workspaceRoot)) {
      errors.push(`路径逃逸: ${hunk.path} 在工作区外`);
      continue;
    }

    if (hunk.type === "add") {
      if (fs.existsSync(resolvedPath)) {
        errors.push(`文件已存在，无法新增: ${hunk.path}`);
      }
    } else if (hunk.type === "delete") {
      if (!fs.existsSync(resolvedPath)) {
        errors.push(`文件不存在，无法删除: ${hunk.path}`);
      }
    } else if (hunk.type === "update") {
      if (!fs.existsSync(resolvedPath)) {
        errors.push(`文件不存在，无法更新: ${hunk.path}`);
        continue;
      }

      const content = fs.readFileSync(resolvedPath, "utf8");
      const eol = detectEOL(content);
      // 按 \r?\n 拆行：混合 EOL 文件里孤立的换行符不会残留在行内容中
      const fileLines = content.split(/\r?\n/);
      let searchStart = 0;

      for (let ci = 0; ci < hunk.chunks.length; ci++) {
        const chunk = hunk.chunks[ci];
        const match = findChunkMatch(fileLines, searchStart, chunk);
        if (!match) {
          errors.push(`${hunk.path}: 第 ${ci + 1} 个编辑块未找到匹配的上下文`);
          break;
        }
        // 模拟应用 chunk，更新 searchStart
        searchStart = match.start + getPostImage(chunk).length;
      }

      // 检查 movePath
      if (hunk.movePath) {
        const moveResolved = path.resolve(workspaceRoot, hunk.movePath);
        if (!isWithinWorkspace(moveResolved, workspaceRoot)) {
          errors.push(`移动目标路径逃逸: ${hunk.movePath}`);
        }
      }
    }
  }

  // 预验证失败 → 全部不执行
  if (errors.length > 0) {
    return { success: false, applied: [], errors };
  }

  // ── 阶段 2：执行全部 hunk ──
  for (const hunk of hunks) {
    const resolvedPath = path.resolve(workspaceRoot, hunk.path);

    try {
      if (hunk.type === "add") {
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, hunk.content, "utf8");
        applied.push(`新增文件: ${hunk.path}`);
        const addLines = hunk.content.split("\n");
        changes.push({
          file: hunk.path,
          kind: "added",
          insertions: addLines.length,
          deletions: 0,
          diff: buildFullFileDiff(addLines, "add"),
        });
      } else if (hunk.type === "delete") {
        const content = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, "utf8") : "";
        fs.unlinkSync(resolvedPath);
        applied.push(`删除文件: ${hunk.path}`);
        const delLines = content.split("\n");
        changes.push({
          file: hunk.path,
          kind: "deleted",
          insertions: 0,
          deletions: delLines.length,
          diff: buildFullFileDiff(delLines, "remove"),
        });
      } else if (hunk.type === "update") {
        const content = fs.readFileSync(resolvedPath, "utf8");
        const eol = detectEOL(content);
        let fileLines = content.split(/\r?\n/);
        let searchStart = 0;
        let chunkFailed = false;
        const diffLines: ToolDiffLine[] = [];
        let insertions = 0;
        let deletions = 0;

        for (const chunk of hunk.chunks) {
          const result = applyChunkToFile(fileLines, chunk, searchStart);
          if (result.error) {
            // 预验证后文件被外部修改的竞态：跳过写入，避免写出错误内容
            errors.push(`${hunk.path}: ${result.error}`);
            chunkFailed = true;
            break;
          }
          fileLines = result.lines;
          searchStart = result.nextSearch;
          // chunk.lines 按行序保留 context/removal/addition 相对位置，直接映射为 diff 行
          for (const line of chunk.lines) {
            if (line.type === "addition") {
              diffLines.push({ type: "add", text: line.content });
              insertions++;
            } else if (line.type === "removal") {
              diffLines.push({ type: "remove", text: line.content });
              deletions++;
            } else {
              diffLines.push({ type: "context", text: line.content });
            }
          }
        }

        if (chunkFailed) continue;

        fs.writeFileSync(resolvedPath, fileLines.join(eol), "utf8");

        if (hunk.movePath) {
          const moveResolved = path.resolve(workspaceRoot, hunk.movePath);
          const moveDir = path.dirname(moveResolved);
          if (!fs.existsSync(moveDir)) fs.mkdirSync(moveDir, { recursive: true });
          fs.renameSync(resolvedPath, moveResolved);
          applied.push(`更新并移动: ${hunk.path} → ${hunk.movePath}`);
          changes.push({
            file: hunk.movePath,
            kind: "renamed",
            insertions,
            deletions,
            diff: diffLines,
          });
        } else {
          applied.push(`更新文件: ${hunk.path}`);
          changes.push({
            file: hunk.path,
            kind: "modified",
            insertions,
            deletions,
            diff: diffLines,
          });
        }
      }
    } catch (err) {
      errors.push(`${hunk.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    success: errors.length === 0,
    applied,
    errors,
    changes: finalizeFileChanges(changes),
  };
}

// ── 工具执行器 ────────────────────────────────────────────

async function executeApplyPatch(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const patch = String(args.patch || "").trim();
  if (!patch) {
    return JSON.stringify({ success: false, applied: [], errors: ["patch 参数不能为空"] });
  }

  const workspaceRoot = ctx?.resolvedWorkspaceRoot;
  if (!workspaceRoot) {
    return JSON.stringify({ success: false, applied: [], errors: ["未绑定工作区，无法执行文件编辑"] });
  }

  // 解析 patch
  const parseResult = parsePatch(patch);
  if (parseResult.errors.length > 0) {
    return JSON.stringify({ success: false, applied: [], errors: parseResult.errors });
  }
  if (parseResult.hunks.length === 0) {
    return JSON.stringify({ success: false, applied: [], errors: ["patch 不包含任何操作"] });
  }

  console.log(LOG_PREFIX, `解析到 ${parseResult.hunks.length} 个 hunk`);

  // Review 基线捕获：在 applyPatchHunks 写文件之前，对每个涉及的文件保存 pre-mutation baseline。
  // write-ahead 语义：先持久化 baseline，再执行 mutation，崩溃后 baseline 不丢。
  if (ctx?.runId) {
    const tracker = getRunReviewTracker(app.getPath("userData"));
    for (const hunk of parseResult.hunks) {
      const absPath = path.resolve(workspaceRoot, hunk.path);
      tracker.captureBefore(ctx.runId, absPath, hunk.path);
      // update + move：记录 rename 关系
      if (hunk.type === "update" && hunk.movePath) {
        const toAbs = path.resolve(workspaceRoot, hunk.movePath);
        tracker.recordRename(ctx.runId, absPath, toAbs, hunk.path, hunk.movePath);
      }
    }
  }

  // 执行
  const result = applyPatchHunks(parseResult.hunks, workspaceRoot);

  if (result.success) {
    console.log(LOG_PREFIX, `成功: ${result.applied.length} 个操作`);
  } else {
    console.warn(LOG_PREFIX, `失败: ${result.errors.length} 个错误`);
  }

  return JSON.stringify(result);
}

// ── 注册 ──────────────────────────────────────────────────

export function registerApplyPatchTool(): void {
  toolRegistry.register({
    id: "apply_patch",
    name: "编辑文件",
    description:
      "使用结构化补丁格式批量编辑文件。支持新增、修改、删除文件，以及多文件多段编辑。\n\n" +
      "补丁格式（Codex 标准）：\n" +
      "*** Begin Patch\n" +
      "*** Update File: src/foo.ts\n" +
      "@@\n" +
      " context line\n" +
      "-removed line\n" +
      "+added line\n" +
      "\n" +
      "*** Add File: src/new.ts\n" +
      "+new file content\n" +
      "\n" +
      "*** Delete File: src/old.ts\n" +
      "*** End Patch\n\n" +
      "行类型：\n" +
      "- 空格开头 = 上下文（不变，用于定位）\n" +
      "- 开头 = 删除行\n" +
      "+ 开头 = 新增行\n" +
      "- 空行 = 上下文空行\n" +
      "- @@ 分隔同一文件内的多个编辑块\n" +
      "- *** Move to: newpath 可在 Update File 后移动文件\n\n" +
      "安全机制：\n" +
      "- 所有路径必须在当前工作区内\n" +
      "- 修改前会预验证全部匹配，任一失败则全部不执行\n" +
      "- 保留原始文件换行符（CRLF/LF）\n\n" +
      "参数：patch（完整的补丁文本）。",
    enabled: true,
    risk: "fs-write",
    modes: ["code", "work"],
    effectKind: "mutation" as const,
    verificationPolicy: "code" as const,
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "完整的补丁文本，以 *** Begin Patch 开头，*** End Patch 结尾",
        },
      },
      required: ["patch"],
    },
    execute: executeApplyPatch,
  });

  console.log(LOG_PREFIX, "已注册：apply_patch");
}
