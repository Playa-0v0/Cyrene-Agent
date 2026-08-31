import * as fs from "fs";
import { getRagStorePath } from "../settings-store";
import { memoryStore } from "./memory-store";
import type { L0Profile, L1Profile, ReflectionLog } from "./memory-types";

export interface MemoryPanelItem {
  id: string;
  title: string;
  body: string;
  meta: string;
}

export interface ImportedDocItem {
  importId: string | null;
  fileName: string;
  chunkCount: number;
  lastImportedAt: number;
}

const REFLECTION_TYPE_LABEL: Record<ReflectionLog["type"], string> = {
  compression: "片段压缩",
  l0_update: "画像更新",
  l1_update: "近况更新",
};

function formatReflectionItem(log: ReflectionLog): MemoryPanelItem {
  const body = log.details ? `${log.summary}\n${log.details}` : log.summary;
  const meta = new Date(log.createdAt).toLocaleString();
  return {
    id: log.id,
    title: REFLECTION_TYPE_LABEL[log.type] ?? log.type,
    body,
    meta,
  };
}

export async function loadMemoryPanelData(): Promise<{
  l0: L0Profile;
  l1: L1Profile;
  l2: unknown[];
  importedDocs: ImportedDocItem[];
  reflections: MemoryPanelItem[];
}> {
  const [l0, l1, l2, reflectionLogs] = await Promise.all([
    memoryStore.getL0(),
    memoryStore.getL1(),
    memoryStore.getAllL2(),
    memoryStore.getReflectionLogs(),
  ]);

  let importedDocs: ImportedDocItem[] = [];
  const ragStorePath = getRagStorePath();

  try {
    if (fs.existsSync(ragStorePath)) {
      const raw = fs.readFileSync(ragStorePath, "utf8");
      const entries = JSON.parse(raw) as Array<{
        source?: string;
        createdAt?: number;
        metadata?: { fileName?: string; importId?: string };
      }>;

      const docsMap = new Map<string, ImportedDocItem>();
      for (const entry of entries) {
        if (entry.source !== "imported_doc") continue;
        const fileName = entry.metadata?.fileName || "未命名文档";
        const importId = entry.metadata?.importId as string | undefined;
        // 新数据按 importId 分组，旧数据按 fileName 分组
        const key = importId || "legacy:" + fileName;
        const existing = docsMap.get(key);
        if (existing) {
          existing.chunkCount += 1;
          existing.lastImportedAt = Math.max(existing.lastImportedAt, entry.createdAt || 0);
        } else {
          docsMap.set(key, {
            importId: importId || null,
            fileName,
            chunkCount: 1,
            lastImportedAt: entry.createdAt || 0,
          });
        }
      }

      importedDocs = [...docsMap.values()].sort((a, b) => b.lastImportedAt - a.lastImportedAt);
    }
  } catch (error) {
    console.warn("[settings] load imported docs failed:", error);
  }

  return {
    l0,
    l1,
    l2: l2.sort((a, b) => b.createdAt - a.createdAt),
    importedDocs,
    reflections: reflectionLogs
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(formatReflectionItem),
  };
}
