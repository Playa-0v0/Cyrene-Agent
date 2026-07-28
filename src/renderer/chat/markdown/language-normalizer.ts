/**
 * 语言别名映射 + 显示名。
 *
 * Shiki 只接受合法 language id（如 typescript / powershell / batch）。
 * `cmd` / `bat` / `ps1` 等仅作为本地别名，不在 Shiki 中注册。
 * 未知语言统一降级为 `text`。
 */

/** Shiki 合法 language id 白名单（与 code-highlighter.ts 的预加载列表一致） */
const SHIKI_LANGS = new Set([
  "javascript",
  "typescript",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "powershell",
  "bash",
  "batch",
  "json",
  "html",
  "css",
  "sql",
  "text",
]);

/** 用户可能写的别名 -> Shiki 合法 id */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",

  js: "javascript",
  javascript: "javascript",

  py: "python",
  python: "python",

  java: "java",

  c: "c",

  cpp: "cpp",
  "c++": "cpp",

  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",

  ps1: "powershell",
  pwsh: "powershell",
  powershell: "powershell",

  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",

  cmd: "batch",
  bat: "batch",
  batch: "batch",

  json: "json",

  html: "html",
  htm: "html",

  css: "css",

  sql: "sql",

  plaintext: "text",
  plain: "text",
  txt: "text",
  text: "text",
  "": "text",
};

/** Shiki 合法 id -> 用户可见的显示名 */
const DISPLAY_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  powershell: "PowerShell",
  bash: "Bash",
  batch: "CMD / Batch",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  text: "代码",
};

/**
 * 把 fence info string（如 `ts` / `c++` / `powershell`）标准化为 Shiki 合法 id。
 * 未知或不在白名单的语言统一降级为 `text`。
 */
export function normalizeLang(input: string | undefined): string {
  const key = (input ?? "").trim().toLowerCase();
  const resolved = ALIASES[key];
  if (resolved && SHIKI_LANGS.has(resolved)) return resolved;
  return "text";
}

/**
 * 获取语言的显示名。输入应为 normalizeLang 的返回值。
 */
export function getLanguageDisplayName(lang: string): string {
  return DISPLAY_NAMES[lang] ?? "代码";
}
