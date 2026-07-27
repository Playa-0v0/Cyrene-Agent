// Sim 自帶的 fixture 解析（極簡版，專注行為測試，不復用 worldbook.ts 的 parser）
// 解析：## title / - 觸發詞: k1, k2 / - 常駐: 是 / - 優先級: N / - 內在價值: N
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
    const keywords = (meta["觸發詞"] ?? "")
      .split(/[,，、]/)
      .map((k) => k.trim())
      .filter(Boolean);
    const intrinsicValue = parseFloat(meta["內在價值"] ?? meta["初始分"] ?? meta["initial_score"] ?? meta["intrinsic_value"] ?? "60") || 60;
    const priority = parseInt(meta["優先級"] ?? "5") || 5;
    const permanent = ["是", "yes", "true"].includes(meta["常駐"] ?? "");

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
