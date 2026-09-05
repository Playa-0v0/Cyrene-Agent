/**
 * normalizeModelMarkdown —— 渲染前的模型 Markdown 归一化。
 *
 * 模型偶尔输出结构畸形但语义明确的 Markdown（实测三类损伤）：
 *   1. `##标题`       —— # 后缺空格，marked 按 CommonMark 解析成纯文本，标题失效
 *   2. `### 标题正文…` —— 标题与正文粘成一行，整段正文被吞进 <h3>
 *   3. `文字```js`     —— 代码围栏粘在句子后面，围栏打不开，代码变行内乱码
 *
 * 这里做确定性的机械修复，代码块内部原样保留。
 * 所有规则幂等：归一化结果再跑一遍不变（流式期间每个 delta 都会重跑）。
 */

/** 行首围栏标记（CommonMark 允许最多 3 空格缩进），用于跟踪代码块开闭 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** 行首 ATX 标题：`#` 至少 1 个、最多 6 个，后跟非空格非 # 字符即缺空格 */
const HEADING_NO_SPACE_RE = /^(#{1,6})(?=[^#\s])/;

/** 围栏粘在文字后面且带语言标注（如 `文字```js`）——语言标注是明确的围栏意图 */
const GLUED_FENCE_RE = /(\S)(`{3})(\w+)\s*$/;

/**
 * 归一化代码块外的单行，可能展开为多行。
 */
function normalizeLine(line: string): string[] {
  // 修复 1：`##标题` 补空格。7 个及以上 # 不是标题，正则天然不匹配
  const text = line.replace(HEADING_NO_SPACE_RE, "$1 ");

  if (!text.startsWith("#")) return [text];

  // 修复 2：标题行里混入正文（模型漏了换行）。启发式：标题不应含句号，
  // 第一个句号后若还有实质内容，就把后半截拆成正文段落（句号删除，
  // 它本来是正文段落的句中停顿）。句号后没有内容则保持原样。
  const periodIndex = text.indexOf("。");
  if (periodIndex > 0) {
    const body = text.slice(periodIndex + 1).trim();
    if (body.length >= 2) {
      return [text.slice(0, periodIndex), "", body];
    }
  }
  return [text];
}

/**
 * 渲染前归一化模型输出的 Markdown。
 */
export function normalizeModelMarkdown(input: string): string {
  // 快速通道：没有 # 也没有 ``` 时必然无事可做
  if (!input.includes("#") && !input.includes("```")) return input;

  const lines = input.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // 围栏开闭行原样保留，只切换状态（开闭都是行首 ```/~~~，取反即可）
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      // 代码块内容一字不动
      out.push(line);
      continue;
    }
    // 修复 3：围栏粘在句子末尾——拆成独立围栏行。
    // 只处理带语言标注的情况（意图明确）；裸 ``` 粘连可能是正文在解释围栏语法，保守不动
    const glued = line.match(GLUED_FENCE_RE);
    if (glued) {
      const cut = line.length - glued[0].length + 1; // 保留粘连前的最后一个字符
      out.push(line.slice(0, cut), "", line.slice(cut));
      continue;
    }
    out.push(...normalizeLine(line));
  }
  return out.join("\n");
}
