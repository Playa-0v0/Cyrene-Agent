import * as fs from "fs";
import * as path from "path";
import { memoryStore } from "./memory-store";
import { entityGraph } from "./entity-graph";
import type { L2Memory, ReflectionLog, ConflictLog } from "./memory-types";
import { logger, LogTag } from "../logger";
import { loadObsidianVaultConfig, saveObsidianVaultConfig, isVaultBound } from "./obsidian-vault-config";
import { isImportingMemory } from "./obsidian-sync-flag";

const MANIFEST_FILE = ".cyrene-export-manifest.json";
const L2_DIR = "记忆";
const ENTITY_DIR = "实体";
const REFLECTION_DIR = "回顾";
const CONFLICT_DIR = "冲突";

const L2_STATUS_LABEL: Record<L2Memory["status"], string> = {
  active: "活跃",
  aging: "衰退",
  archived: "归档",
  superseded: "已替代",
  merged: "已合并",
};

export interface ExportResult {
  ok: boolean;
  outputPath?: string;
  fileCount?: number;
  error?: string;
}

interface ExportManifest {
  exportedAt: number;
  files: string[];
}

// ── 工具函数 ──

/** 把任意字符串变成可用的文件名（避免 / \ : * ? " < > |） */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "_unnamed_";
}

/** ISO 时间字符串，失败回退原数字 */
function formatTime(ts: number | undefined): string {
  if (!ts) return "";
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

/** YAML 转义字符串值 */
function yamlString(value: string): string {
  if (value === "") return '""';
  // 含特殊字符则用双引号包裹并转义
  if (/[:#&*!|>'"%@`{}[\]]/.test(value) || value.includes("\n")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** 把字符串数组格式化成 YAML 行内数组 */
function yamlArray(items: string[]): string {
  if (items.length === 0) return "[]";
  return `[${items.map((i) => yamlString(i)).join(", ")}]`;
}

// ── L2 双链解析 ──

/** 建立 ragId → L2 id 的索引，用于 conflictWith 反查 */
function buildRagIdToL2IdMap(l2List: L2Memory[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const mem of l2List) {
    if (mem.ragId) map.set(mem.ragId, mem.id);
  }
  return map;
}

/**
 * 建立 L2 id → slug 的索引，用于文件名/wikilink 反查。
 *
 * 同 slug 冲突时自动加 -2/-3 后缀去重，避免：
 *   1. 文件名撞车 → 后写覆盖先写
 *   2. wikilink `[[slug]]` 歧义 → Obsidian 随机解析
 *   3. manifest 漏记旧文件 → 残留
 *
 * 注意：返回的是去重后的 link name，可能与 mem.slug（原始 LLM 输出）不同。
 * frontmatter 仍存原始 mem.slug 作为用户可见标题。
 */
function buildIdToSlugMap(l2List: L2Memory[]): Map<string, string> {
  const map = new Map<string, string>();
  const usedLinkNames = new Set<string>();

  for (const mem of l2List) {
    if (!mem.slug) continue;
    const baseLinkName = sanitizeFileName(mem.slug);
    if (baseLinkName === "_unnamed_") continue; // sanitize 兜底，不值得占用 link name

    let linkName = baseLinkName;
    let suffix = 2;
    while (usedLinkNames.has(linkName)) {
      linkName = `${baseLinkName}-${suffix}`;
      suffix++;
    }
    usedLinkNames.add(linkName);
    map.set(mem.id, linkName);
  }

  return map;
}

/** L2 的文件名/wikilink 锚点：优先用 slug，缺失回退到 id */
function l2LinkName(id: string, idToSlug: Map<string, string>): string {
  return sanitizeFileName(idToSlug.get(id) ?? id);
}

/** 实体名作为文件名（不含扩展名），用于 [[双链]] */
function entityLinkName(name: string): string {
  return sanitizeFileName(name);
}

/**
 * 扫描 L2.content，找出其中提到的所有实体名。
 * 用实体图谱里已有的实体（含别名）做匹配，按名称长度倒序避免短名误匹配。
 */
function findEntitiesInContent(
  content: string,
  entityNames: Array<{ name: string; linkName: string }>,
): Array<{ name: string; linkName: string }> {
  const hits: Array<{ name: string; linkName: string }> = [];
  for (const e of entityNames) {
    if (content.includes(e.name)) {
      hits.push(e);
    }
  }
  return hits;
}

// ── 文件内容生成 ──

function buildL2Markdown(
  mem: L2Memory,
  ragIdToL2Id: Map<string, string>,
  idToSlug: Map<string, string>,
  entityHits: Array<{ name: string; linkName: string }>,
): string {
  const lines: string[] = [];

  // frontmatter
  const tags = ["记忆", "片段", mem.status];
  if (mem.isPinned) tags.push("置顶");
  if (mem.isSummary) tags.push("总结");

  lines.push("---");
  lines.push(`id: ${yamlString(mem.id)}`);
  if (mem.slug) lines.push(`slug: ${yamlString(mem.slug)}`);
  if (mem.sourceQuote) lines.push(`sourceQuote: ${yamlString(mem.sourceQuote)}`);
  lines.push(`type: 片段`);
  lines.push(`status: ${L2_STATUS_LABEL[mem.status]}`);
  lines.push(`weight: ${mem.weight}`);
  lines.push(`accessCount: ${mem.accessCount}`);
  lines.push(`isPinned: ${mem.isPinned}`);
  if (mem.isSummary) lines.push(`isSummary: true`);
  lines.push(`createdAt: ${formatTime(mem.createdAt)}`);
  lines.push(`lastAccessedAt: ${formatTime(mem.lastAccessedAt)}`);
  if (mem.sourceConversationId) lines.push(`sourceConversationId: ${yamlString(mem.sourceConversationId)}`);
  if (mem.ragId) lines.push(`ragId: ${yamlString(mem.ragId)}`);
  lines.push(`tags: ${yamlArray(tags)}`);
  lines.push("---");
  lines.push("");

  // 正文
  lines.push(`# ${mem.content.split("\n")[0].slice(0, 60) || "(空记忆)"}`);
  lines.push("");
  lines.push(mem.content);
  lines.push("");

  // 关联段落（这里出现的 [[xxx]] 就是 Obsidian 图谱的边）
  const relations: string[] = [];

  // L2 → L2：subEntryIds（被压缩的原始条目）
  if (mem.subEntryIds && mem.subEntryIds.length > 0) {
    const links = mem.subEntryIds.map((id) => `[[${l2LinkName(id, idToSlug)}]]`).join(" ");
    relations.push(`- 压缩自：${links}`);
  }

  // L2 → L2：supersededBy
  if (mem.supersededBy) {
    relations.push(`- 被替代为：[[${l2LinkName(mem.supersededBy, idToSlug)}]]`);
  }

  // L2 → L2：mergedInto
  if (mem.mergedInto) {
    relations.push(`- 合并入：[[${l2LinkName(mem.mergedInto, idToSlug)}]]`);
  }

  // L2 → L2：conflictWith（ragId 需反查 L2 id）
  if (mem.conflictWith && mem.conflictWith.length > 0) {
    const links: string[] = [];
    for (const ragId of mem.conflictWith) {
      const l2Id = ragIdToL2Id.get(ragId);
      if (l2Id) {
        links.push(`[[${l2LinkName(l2Id, idToSlug)}]]`);
      } else {
        links.push(`(未知 ragId: ${ragId})`);
      }
    }
    if (links.length > 0) relations.push(`- 冲突：${links.join(" ")}`);
  }

  // L2 → 实体：content 中提到的实体
  if (entityHits.length > 0) {
    const links = entityHits.map((e) => `[[${e.linkName}]]`).join(" ");
    relations.push(`- 提及实体：${links}`);
  }

  if (relations.length > 0) {
    lines.push("## 关联");
    lines.push("");
    relations.forEach((r) => lines.push(r));
    lines.push("");
  }

  return lines.join("\n");
}

function buildEntityMarkdown(
  name: string,
  type: string,
  mentionCount: number,
  firstMentionedAt: number,
  lastMentionedAt: number,
  linkedL2Ids: string[],
  idToSlug: Map<string, string>,
): string {
  const lines: string[] = [];
  const typeLabel = entityTypeName(type);

  lines.push("---");
  lines.push(`name: ${yamlString(name)}`);
  lines.push(`type: ${typeLabel}`);
  lines.push(`mentionCount: ${mentionCount}`);
  lines.push(`firstMentionedAt: ${formatTime(firstMentionedAt)}`);
  lines.push(`lastMentionedAt: ${formatTime(lastMentionedAt)}`);
  lines.push(`tags: ${yamlArray(["实体", typeLabel])}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${name}`);
  lines.push("");
  lines.push(`**类型**：${typeLabel}`);
  lines.push("");
  lines.push(`**提及次数**：${mentionCount}`);
  lines.push("");

  if (linkedL2Ids.length > 0) {
    lines.push("## 出现于");
    lines.push("");
    linkedL2Ids.forEach((id) => lines.push(`- [[${l2LinkName(id, idToSlug)}]]`));
    lines.push("");
  }

  return lines.join("\n");
}

function entityTypeName(type: string): string {
  switch (type) {
    case "person": return "人物";
    case "place": return "地点";
    case "organization": return "组织";
    case "preference": return "偏好";
    case "concept": return "概念";
    default: return type;
  }
}

function buildL0Markdown(l0: {
  preferredName: string;
  occupation: string;
  longTermInterests: string;
  language: string;
  permanentNote: string;
}): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: 画像`);
  lines.push(`preferredName: ${yamlString(l0.preferredName)}`);
  lines.push(`occupation: ${yamlString(l0.occupation)}`);
  lines.push(`language: ${yamlString(l0.language)}`);
  lines.push(`tags: ${yamlArray(["画像", "L0"])}`);
  lines.push("---");
  lines.push("");
  lines.push("# 用户画像");
  lines.push("");
  if (l0.preferredName) {
    lines.push(`**称呼**：${l0.preferredName}`);
    lines.push("");
  }
  if (l0.occupation) {
    lines.push(`**职业**：${l0.occupation}`);
    lines.push("");
  }
  if (l0.longTermInterests) {
    lines.push("## 长期兴趣");
    lines.push("");
    lines.push(l0.longTermInterests);
    lines.push("");
  }
  if (l0.permanentNote) {
    lines.push("## 备注");
    lines.push("");
    lines.push(l0.permanentNote);
    lines.push("");
  }
  return lines.join("\n");
}

function buildL1Markdown(l1: {
  recentGoals: string;
  recentPreferences: string;
  currentProject: string;
  generatedAt: number;
  roundCount: number;
}): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: 近况`);
  lines.push(`generatedAt: ${formatTime(l1.generatedAt)}`);
  lines.push(`roundCount: ${l1.roundCount}`);
  lines.push(`tags: ${yamlArray(["近况", "L1"])}`);
  lines.push("---");
  lines.push("");
  lines.push("# 近期状态");
  lines.push("");
  if (l1.recentGoals) {
    lines.push("## 近期目标");
    lines.push("");
    lines.push(l1.recentGoals);
    lines.push("");
  }
  if (l1.recentPreferences) {
    lines.push("## 近期偏好");
    lines.push("");
    lines.push(l1.recentPreferences);
    lines.push("");
  }
  if (l1.currentProject) {
    lines.push("## 当前项目");
    lines.push("");
    lines.push(l1.currentProject);
    lines.push("");
  }
  return lines.join("\n");
}

function buildReflectionMarkdown(log: ReflectionLog): string {
  const typeLabel =
    log.type === "compression" ? "片段压缩"
    : log.type === "l0_update" ? "画像更新"
    : log.type === "l1_update" ? "近况更新"
    : log.type;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${yamlString(log.id)}`);
  lines.push(`type: ${typeLabel}`);
  lines.push(`createdAt: ${formatTime(log.createdAt)}`);
  lines.push(`tags: ${yamlArray(["回顾", typeLabel])}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${typeLabel}`);
  lines.push("");
  lines.push(`**时间**：${new Date(log.createdAt).toLocaleString()}`);
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(log.summary);
  if (log.details) {
    lines.push("");
    lines.push("## 详情");
    lines.push("");
    lines.push(log.details);
  }
  lines.push("");
  return lines.join("\n");
}

function buildConflictMarkdown(log: ConflictLog, idToSlug: Map<string, string>): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${yamlString(log.id)}`);
  lines.push(`status: ${log.status}`);
  lines.push(`sourceL2Id: ${yamlString(log.sourceL2Id)}`);
  lines.push(`targetL2Id: ${yamlString(log.targetL2Id)}`);
  lines.push(`createdAt: ${formatTime(log.createdAt)}`);
  lines.push(`confidence: ${log.confidence}`);
  lines.push(`detector: ${log.detector}`);
  lines.push(`tags: ${yamlArray(["冲突", log.status])}`);
  lines.push("---");
  lines.push("");
  lines.push(`# 冲突记录`);
  lines.push("");
  lines.push(`**状态**：${log.status}`);
  lines.push(`**检测器**：${log.detector}`);
  lines.push(`**置信度**：${log.confidence}`);
  lines.push("");
  lines.push("## 原因");
  lines.push("");
  lines.push(log.reason);
  lines.push("");
  lines.push("## 涉及记忆");
  lines.push("");
  lines.push(`- 源：[[${l2LinkName(log.sourceL2Id, idToSlug)}]]`);
  lines.push(`- 目标：[[${l2LinkName(log.targetL2Id, idToSlug)}]]`);
  lines.push("");
  return lines.join("\n");
}

// ── 主导出函数 ──

/**
 * 把当前记忆库导出为 Obsidian vault。
 *
 * @param outputDir 用户指定的输出目录（vault 根目录）
 * @returns 导出结果
 */
export async function exportMemoryToObsidianVault(outputDir: string): Promise<ExportResult> {
  try {
    // 1. 准备目录
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const l2Dir = path.join(outputDir, L2_DIR);
    const entityDir = path.join(outputDir, ENTITY_DIR);
    const reflectionDir = path.join(outputDir, REFLECTION_DIR);
    const conflictDir = path.join(outputDir, CONFLICT_DIR);

    // 2. 读旧 manifest，删除上次导出的文件（用户自己加的 md 不动）
    const manifestPath = path.join(outputDir, MANIFEST_FILE);
    const writtenFiles: string[] = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const oldManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ExportManifest;
        for (const relPath of oldManifest.files ?? []) {
          const absPath = path.join(outputDir, relPath);
          if (fs.existsSync(absPath)) {
            try {
              fs.unlinkSync(absPath);
            } catch {
              // 忽略单个文件删除失败
            }
          }
        }
      } catch {
        // manifest 损坏，跳过清理
      }
    }

    // 3. 建子目录
    for (const dir of [l2Dir, entityDir, reflectionDir, conflictDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    // 4. 加载数据
    const [l0, l1, l2List, reflectionLogs, conflictLogs] = await Promise.all([
      memoryStore.getL0(),
      memoryStore.getL1(),
      memoryStore.getAllL2(),
      memoryStore.getReflectionLogs(),
      memoryStore.getConflictLogs(),
    ]);

    const ragIdToL2Id = buildRagIdToL2IdMap(l2List);
    const idToSlug = buildIdToSlugMap(l2List);

    // 5. 写 L0
    const l0Path = path.join(outputDir, "画像.md");
    fs.writeFileSync(l0Path, buildL0Markdown(l0), "utf8");
    writtenFiles.push("画像.md");

    // 6. 写 L1
    const l1Path = path.join(outputDir, "近况.md");
    fs.writeFileSync(l1Path, buildL1Markdown(l1), "utf8");
    writtenFiles.push("近况.md");

    // 7. 准备实体名索引（含别名）
    let entityData: { entities: Array<{ id: string; name: string; type: string; aliases: string[]; mentionCount: number; firstMentionedAt: number; lastMentionedAt: number }>; relations: unknown[] } = { entities: [], relations: [] };
    try {
      entityData = entityGraph.load();
    } catch {
      // entity-graph 在非 electron 环境可能不可用
    }

    const entityNames: Array<{ name: string; linkName: string }> = [];
    for (const e of entityData.entities) {
      entityNames.push({ name: e.name, linkName: entityLinkName(e.name) });
      for (const alias of e.aliases) {
        entityNames.push({ name: alias, linkName: entityLinkName(e.name) }); // 别名也指向主实体文件
      }
    }
    // 按名称长度倒序，避免短名先匹配
    entityNames.sort((a, b) => b.name.length - a.name.length);

    // 8. 写 L2 条目
    for (const mem of l2List) {
      const entityHits = findEntitiesInContent(mem.content, entityNames);
      // 去重：同一个实体可能多次出现，且别名和主名都匹配
      const seenLinkNames = new Set<string>();
      const uniqueHits = entityHits.filter((h) => {
        if (seenLinkNames.has(h.linkName)) return false;
        seenLinkNames.add(h.linkName);
        return true;
      });

      const md = buildL2Markdown(mem, ragIdToL2Id, idToSlug, uniqueHits);
      const fileName = `${l2LinkName(mem.id, idToSlug)}.md`;
      const filePath = path.join(l2Dir, fileName);
      fs.writeFileSync(filePath, md, "utf8");
      writtenFiles.push(`${L2_DIR}/${fileName}`);
    }

    // 9. 写实体条目（反向建立 实体 → L2 的链接）
    // 遍历每条 L2，扫 content 找实体，建立 实体名 → L2 id 列表 的映射
    const entityToL2Ids = new Map<string, string[]>();
    for (const mem of l2List) {
      const hits = findEntitiesInContent(mem.content, entityNames);
      for (const hit of hits) {
        const arr = entityToL2Ids.get(hit.linkName) ?? [];
        if (!arr.includes(mem.id)) arr.push(mem.id);
        entityToL2Ids.set(hit.linkName, arr);
      }
    }

    for (const e of entityData.entities) {
      const linkName = entityLinkName(e.name);
      const linkedL2Ids = entityToL2Ids.get(linkName) ?? [];
      const md = buildEntityMarkdown(
        e.name,
        e.type,
        e.mentionCount,
        e.firstMentionedAt,
        e.lastMentionedAt,
        linkedL2Ids,
        idToSlug,
      );
      const fileName = `${linkName}.md`;
      const filePath = path.join(entityDir, fileName);
      fs.writeFileSync(filePath, md, "utf8");
      writtenFiles.push(`${ENTITY_DIR}/${fileName}`);
    }

    // 10. 写回顾日志
    for (const log of reflectionLogs) {
      const md = buildReflectionMarkdown(log);
      const fileName = `${sanitizeFileName(log.id)}.md`;
      const filePath = path.join(reflectionDir, fileName);
      fs.writeFileSync(filePath, md, "utf8");
      writtenFiles.push(`${REFLECTION_DIR}/${fileName}`);
    }

    // 11. 写冲突日志
    for (const log of conflictLogs) {
      const md = buildConflictMarkdown(log, idToSlug);
      const fileName = `${sanitizeFileName(log.id)}.md`;
      const filePath = path.join(conflictDir, fileName);
      fs.writeFileSync(filePath, md, "utf8");
      writtenFiles.push(`${CONFLICT_DIR}/${fileName}`);
    }

    // 12. 写 manifest（记录本次导出的所有文件，下次导出前清理）
    const manifest: ExportManifest = {
      exportedAt: Date.now(),
      files: writtenFiles,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    logger.info(LogTag.Cyrene, `[obsidian-export] exported ${writtenFiles.length} files to ${outputDir}`);

    return {
      ok: true,
      outputPath: outputDir,
      fileCount: writtenFiles.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LogTag.Cyrene, `[obsidian-export] failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ── 绑定模式（单向同步 PMRS → Obsidian）──

export interface SyncResult {
  ok: boolean;
  vaultPath?: string;
  fileCount?: number;
  error?: string;
  skipped?: boolean; // 未绑定或未开启自动同步时跳过
}

/**
 * 同步到已绑定的 vault。
 * - 未绑定：返回 { ok: false, skipped: true }
 * - 已绑定：调用 exportMemoryToObsidianVault，更新 lastSyncAt
 */
export async function syncToBoundVault(): Promise<SyncResult> {
  const config = loadObsidianVaultConfig();
  if (!config.vaultPath) {
    return { ok: false, skipped: true, error: "未绑定 vault" };
  }

  const result = await exportMemoryToObsidianVault(config.vaultPath);
  if (result.ok) {
    saveObsidianVaultConfig({ lastSyncAt: Date.now() });
    return {
      ok: true,
      vaultPath: config.vaultPath,
      fileCount: result.fileCount,
    };
  }
  return { ok: false, error: result.error };
}

// ── 防抖自动同步 ──

let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 2000;

/**
 * 记忆写入后调用此函数。
 * 如果已绑定 vault 且开启 autoSync，防抖 2s 后触发同步。
 * 防抖：多次连续写入只触发一次同步。
 * 注意：回流（Obsidian→PMRS）期间会跳过，避免双向循环。
 * （主防御在 memory-store.save() 同步检查标志；此处为兜底。）
 */
export function notifyMemoryChanged(): void {
  if (isImportingMemory()) return; // 回流触发的写入，跳过反向同步
  if (!isVaultBound()) return;
  const config = loadObsidianVaultConfig();
  if (!config.autoSync) return;

  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncToBoundVault().then((r) => {
      if (r.ok) {
        logger.info(LogTag.Cyrene, `[obsidian-sync] auto-synced ${r.fileCount} files to ${r.vaultPath}`);
      } else if (!r.skipped) {
        logger.warn(LogTag.Cyrene, `[obsidian-sync] auto-sync failed: ${r.error}`);
      }
    });
  }, SYNC_DEBOUNCE_MS);
}
