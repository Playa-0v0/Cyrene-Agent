// Skill meta-tool —— 把 skill 系統暴露給 LLM 的兩個工具。
// 不把每個 skill 註冊成業務 tool（skill 是指令層），而是用兩個 meta-tool：
//   invoke_skill：加載某 skill 的 SKILL.md 正文 + references 清單
//   read_skill_reference：按需讀 references 附件（帶路徑穿越防護）
// 註冊進現有 toolRegistry，兩處 LLM 路徑都從 registry 取，自動生效。

import { toolRegistry } from "../orchestrator/tool-registry";
import { skillRegistry } from "./skill-registry";

const LOG_PREFIX = "[SkillTools]";

// skill 正文 / reference 返回時的字符上限。CyreneAgent 的 FC 循環把 tool 返回值
// 永久留在 conversation 裡，超大正文（xlsx 8.5KB、skill-creator 33KB、docx 的
// openxml_encyclopedia 單個 144KB）會頂過推理模型單輪 30s 預算導致連續超時。
// 官方 skill 系統靠宿主 agent（Claude Code 等）的上下文壓縮兜底，我們沒那層，得自己截斷。
const SKILL_BODY_MAX_CHARS = 6000;
const SKILL_REF_MAX_CHARS = 8000;

/** 截斷文本到 maxChars，超長時末尾附提示。保留前部（任務路由表/關鍵規則通常在前）。 */
function truncateForContext(text: string, maxChars: number, hint: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) +
    "\n\n[...正文過長已截斷，僅顯示前 " + maxChars + " 字符。" + hint + "...]";
}

/**
 * 每輪對話的 reference 已讀記錄（skill_id + ref → true）。
 * FC 循環開始時調 resetReadRefs() 清空。防止模型在同一輪任務裡重複讀同一文件。
 */
const readRefs = new Set<string>();

/** 每輪 FC 循環開始前調，清空已讀記錄。由 cyrene-agent.ts 在循環入口調。 */
export function resetReadRefs(): void {
  readRefs.clear();
}

/**
 * 執行紀律提示，拼在 invoke_skill 返回內容末尾。
 * 約束模型"夠用即執行、不重複讀、不探索式遍歷"，避免浪費輪數。
 */
const EXECUTION_DISCIPLINE =
  "\n\n---\n" +
  "【執行紀律 — 必須遵守】\n" +
  "1. 只讀完成任務所需的最少 reference，讀到能執行就立即開始，不要把所有文檔都讀一遍。\n" +
  "2. 同一 reference 文件不要重複讀取（系統會攔截重複讀取）。\n" +
  "3. 不要用 list_dir 遍歷 templates/scripts 目錄——模板和腳本路徑上文已給出，直接用。\n" +
  "4. 信息足夠後立即用其他工具執行產出，不要繼續研究。\n" +
  "5. 若預計輪數緊張，優先輸出可交付版本而非繼續優化格式。";

/**
 * 註冊 skill 系統的兩個 meta-tool 進 toolRegistry。
 * 標 risk:"safe"（只讀本地 skill 文件），免權限打擾。
 * initSkills 啟動時調一次。
 */
export function registerSkillTools(): void {
  toolRegistry.register({
    id: "invoke_skill",
    name: "調用 Skill",
    description:
      "加載某個 skill 的詳細執行指令。當你判斷當前任務適用某 skill 時（見系統提示裡的「可用 Skill」清單），調用此工具獲取該 skill 的完整指令，再按指令用其他工具執行。\n\n" +
      "何時用：系統提示的「可用 Skill」清單裡某條 description 適用於當前任務。\n\n" +
      "不要用於：清單裡沒有的 skill id。\n\n" +
      "參數：skill_id（必填，skill 的 id，見清單裡的標識）。\n\n" +
      "返回：該 skill 的指令正文 + 可用的 references 文件清單。若正文引用了 references/xxx，需要詳情時再用 read_skill_reference 讀取。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "skill 的 id（見「可用 Skill」清單）" },
      },
      required: ["skill_id"],
    },
    execute: async (args) => {
      const id = String(args.skill_id || "");
      const skill = skillRegistry.getById(id);
      if (!skill || !skill.enabled) {
        const available = skillRegistry.getEnabled().map(s => s.id).join(", ") || "(無)";
        return `[invoke_skill] skill not found: ${id}。可用 skill: ${available}`;
      }
      const body = skillRegistry.getBody(id);
      if (body === null) {
        return `[invoke_skill] 讀取 skill 正文失敗: ${id}`;
      }
      const refList = skill.references.length > 0
        ? `\n\n可用 references（需要詳情時調 read_skill_reference 讀取）：\n${skill.references.map(r => "- " + r).join("\n")}`
        : "";
      console.log(LOG_PREFIX, "invoke_skill:", id, "bodyLen=" + body.length);
      const truncatedBody = truncateForContext(
        body,
        SKILL_BODY_MAX_CHARS,
        "如需完整指令或特定部分，可用 read_skill_reference 精準讀取對應 reference 文件",
      );
      return `[已加載 skill: ${id}]\n${truncatedBody}${refList}${EXECUTION_DISCIPLINE}`;
    },
  });

  toolRegistry.register({
    id: "read_skill_reference",
    name: "讀取 Skill 附件",
    description:
      "讀取某 skill 的 references 附件內容。當 invoke_skill 返回的正文引用了 references/xxx 且你需要詳情時調用。\n\n" +
      "何時用：invoke_skill 返回的正文提到 references/xxx 且需要該附件的詳細內容。\n\n" +
      "不要用於：不在 invoke_skill 返回清單裡的 ref。\n\n" +
      "參數：skill_id（必填），ref（必填，references 文件名，必須是 invoke_skill 返回清單裡的）。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "skill 的 id" },
        ref:      { type: "string", description: "references 文件名（必須命中 invoke_skill 返回的清單）" },
      },
      required: ["skill_id", "ref"],
    },
    execute: async (args) => {
      const id = String(args.skill_id || "");
      const ref = String(args.ref || "");
      const skill = skillRegistry.getById(id);
      if (!skill || !skill.enabled) {
        return `[read_skill_reference] skill not found: ${id}`;
      }
      // 去重：同一輪內同一 reference 不重複返回（內容已在對話歷史裡，再讀浪費輪數+token）
      const readKey = `${id}/${ref}`;
      if (readRefs.has(readKey)) {
        return `[read_skill_reference] "${ref}" 已在本輪讀過，內容已在對話中，不要重複讀取。` +
          `如需其他文件，可讀：${skill.references.filter(r => !readRefs.has(`${id}/${r}`)).join(", ") || "(全部已讀)"}`;
      }
      const content = skillRegistry.getReference(id, ref);
      if (content === null) {
        return `[read_skill_reference] 讀取失敗（ref 不在清單或文件不存在）: ${ref}。可用: ${skill.references.join(", ") || "(無)"}`;
      }
      readRefs.add(readKey);
      console.log(LOG_PREFIX, "read_skill_reference:", id, ref, "len=" + content.length);
      const truncated = truncateForContext(
        content,
        SKILL_REF_MAX_CHARS,
        "如需後半部分內容，請分段讀取或說明你需要的具體章節",
      );
      return truncated;
    },
  });

  console.log(LOG_PREFIX, "已註冊：invoke_skill / read_skill_reference");
}
