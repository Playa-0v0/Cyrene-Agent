// Sim 自带的 fixture 解析（极简版，专注行为测试，不复用 worldbook.ts 的 parser）
// 解析：## title / - 触发词: k1, k2 / - 常驻: 是 / - 优先级: N / - 内在价值: N
import type { WorldbookEntry } from "../../rag/worldbook";

export function parseFixtureMarkdown(content: string, fileName: string): WorldbookEntry[] {
  const entries: WorldbookEntry[] = [];
  const blocks = content.split(/^---$/m);

  for (const block of blocks) {
    const lines = block.split("\n");
    let title = "";
    const meta: Record<string, string> = {};
    let inMeta = true;
    const contentLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (title === "" && trimmed.startsWith("## ")) {
        title = trimmed.replace(/^## /, "").trim();
        continue;
      }
      if (inMeta && trimmed.startsWith("- ")) {
        const m = trimmed.match(/^- ([^:：]+)[：:]\s*(.*)$/);
        if (m) meta[m[1].trim()] = m[2].trim();
        continue;
      }
      if (inMeta && trimmed === "") {
        if (title !== "" && Object.keys(meta).length > 0) {
          inMeta = false;
        }
        continue;
      }
      if (!inMeta) {
        contentLines.push(line);
      }
    }

    if (!title || contentLines.join("").trim() === "") continue;
    const keywords = (meta["触发词"] ?? "")
      .split(/[,，、]/)
      .map((k) => k.trim())
      .filter(Boolean);
    const intrinsicValue = parseFloat(meta["内在价值"] ?? meta["初始分"] ?? meta["initial_score"] ?? meta["intrinsic_value"] ?? "60") || 60;
    const priority = parseInt(meta["优先级"] ?? "5") || 5;
    const permanent = ["是", "yes", "true"].includes(meta["常驻"] ?? "");

    entries.push({
      id: `wb_${fileName}_${title.replace(/\s+/g, "_")}`,
      keywords,
      content: contentLines.join("\n").trim(),
      priority,
      permanent,
      enabled: true,
      intrinsicValue,
      linkTriggers: [],
    });
  }

  return entries;
}
