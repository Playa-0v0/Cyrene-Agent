import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { app } from "electron";

export interface CodexImageJob {
  id: string;
  prompt: string;
  requestedByUserId: string;
  requestedByName: string;
  requestedAt: string;
  source: "discord";
  promptMode: "keywords";
  /** Discord 對話來源；舊任務缺少此欄位時會安全降級為擁有者私訊。 */
  responseChannelId?: string;
  responseGuildId?: string | null;
}

export interface CodexImageResult {
  jobId: string;
  status: "completed" | "failed";
  imagePath?: string;
  expandedPrompt?: string;
  error?: string;
  completedAt: string;
}

export interface CodexImageDelivery {
  job: CodexImageJob;
  result: CodexImageResult;
  resultFile: string;
}

export function getCodexImageBridgeRoot(): string {
  return path.join(app.getPath("userData"), "codex-image-bridge");
}

function ensureBridgeDirectories(root: string): void {
  for (const name of ["pending", "records", "completed", "processed", "output"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function createCodexImageJob(
  input: Pick<CodexImageJob, "prompt" | "requestedByUserId" | "requestedByName" | "responseChannelId" | "responseGuildId">,
  root = getCodexImageBridgeRoot(),
): CodexImageJob {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("繪圖描述不可為空。");
  if (prompt.length > 1800) throw new Error("繪圖描述不可超過 1800 個字元。");
  if (!/^\d{15,22}$/.test(input.requestedByUserId)) throw new Error("Discord 使用者 ID 格式無效。");
  if (!input.responseChannelId || !/^\d{15,22}$/.test(input.responseChannelId)) {
    throw new Error("Discord 回傳頻道 ID 格式無效。");
  }
  if (input.responseGuildId && !/^\d{15,22}$/.test(input.responseGuildId)) {
    throw new Error("Discord 伺服器 ID 格式無效。");
  }
  ensureBridgeDirectories(root);
  const job: CodexImageJob = {
    id: randomUUID(),
    prompt,
    requestedByUserId: input.requestedByUserId,
    requestedByName: input.requestedByName.slice(0, 100),
    requestedAt: new Date().toISOString(),
    source: "discord",
    promptMode: "keywords",
    responseChannelId: input.responseChannelId,
    responseGuildId: input.responseGuildId ?? null,
  };
  writeJsonAtomic(path.join(root, "records", `${job.id}.json`), job);
  writeJsonAtomic(path.join(root, "pending", `${job.id}.json`), job);
  return job;
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function listCodexImageDeliveries(root = getCodexImageBridgeRoot()): CodexImageDelivery[] {
  ensureBridgeDirectories(root);
  const completedDir = path.join(root, "completed");
  const deliveries: CodexImageDelivery[] = [];
  for (const name of fs.readdirSync(completedDir).filter((item) => item.endsWith(".json")).sort()) {
    const resultFile = path.join(completedDir, name);
    const result = readJson<CodexImageResult>(resultFile);
    if (!result || !/^[0-9a-f-]{36}$/i.test(result.jobId)) continue;
    const job = readJson<CodexImageJob>(path.join(root, "records", `${result.jobId}.json`));
    if (!job || job.id !== result.jobId || job.source !== "discord") continue;
    deliveries.push({ job, result, resultFile });
  }
  return deliveries;
}

export function validateCodexImageOutput(imagePath: string, root = getCodexImageBridgeRoot()): string {
  ensureBridgeDirectories(root);
  const outputRoot = fs.realpathSync(path.join(root, "output"));
  const resolved = fs.realpathSync(imagePath);
  if (resolved !== outputRoot && !resolved.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("圖片輸出不在受信任的 Codex bridge 目錄內。");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 25 * 1024 * 1024) {
    throw new Error("圖片檔案不存在、為空或超過 Discord 25 MB 限制。");
  }
  if (!/\.(?:png|jpe?g|webp)$/i.test(resolved)) throw new Error("只允許 PNG、JPEG 或 WebP 圖片。");
  return resolved;
}

export function markCodexImageDeliveryProcessed(
  delivery: CodexImageDelivery,
  root = getCodexImageBridgeRoot(),
): void {
  ensureBridgeDirectories(root);
  const target = path.join(root, "processed", path.basename(delivery.resultFile));
  fs.renameSync(delivery.resultFile, target);
}

export function createCodexImageQueueTestRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-codex-image-"));
}
