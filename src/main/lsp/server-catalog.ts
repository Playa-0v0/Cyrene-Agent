import path from "node:path";
import type { LspServerDefinition, LspServerOverride } from "./types";

function server(
  id: string,
  extensions: string[],
  command: string,
  args: string[],
  rootMarkers: string[],
  installHint: string,
): LspServerDefinition {
  return { id, extensions, commands: [{ command, args }], rootMarkers, installHint };
}

export const BUILTIN_LSP_SERVERS: readonly LspServerDefinition[] = [
  server("typescript-language-server", [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"], "typescript-language-server", ["--stdio"], ["tsconfig.json", "jsconfig.json", "package.json", ".git"], "安装 typescript-language-server 与 typescript，并确保 typescript-language-server 位于 PATH。"),
  server("python-pyright", [".py", ".pyi"], "pyright-langserver", ["--stdio"], ["pyproject.toml", "requirements.txt", "setup.py", ".git"], "安装 pyright，并确保 pyright-langserver 位于 PATH。"),
  server("gopls", [".go"], "gopls", [], ["go.mod", ".git"], "安装 gopls，并确保 gopls 位于 PATH。"),
  server("rust-analyzer", [".rs"], "rust-analyzer", [], ["Cargo.toml", ".git"], "安装 rust-analyzer，并确保 rust-analyzer 位于 PATH。"),
  server("clangd", [".c", ".h", ".cc", ".cp", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], "clangd", [], ["compile_commands.json", "CMakeLists.txt", ".git"], "安装 clangd，并确保 clangd 位于 PATH。"),
  server("jdtls", [".java"], "jdtls", [], ["pom.xml", "build.gradle", "settings.gradle", ".git"], "安装 Eclipse JDT Language Server，并确保 jdtls 位于 PATH。"),
  server("omnisharp", [".cs", ".csx"], "OmniSharp", ["-lsp"], ["*.sln", "*.csproj", ".git"], "安装 OmniSharp，并确保 OmniSharp 位于 PATH。"),
  server("intelephense", [".php"], "intelephense", ["--stdio"], ["composer.json", ".git"], "安装 intelephense，并确保 intelephense 位于 PATH。"),
  server("ruby-lsp", [".rb", ".rake", ".gemspec"], "ruby-lsp", [], ["Gemfile", ".ruby-version", ".git"], "安装 ruby-lsp，并确保 ruby-lsp 位于 PATH。"),
  server("kotlin-language-server", [".kt", ".kts"], "kotlin-language-server", [], ["build.gradle", "settings.gradle", ".git"], "安装 kotlin-language-server，并确保它位于 PATH。"),
  server("lua-language-server", [".lua"], "lua-language-server", [], [".luarc.json", ".git"], "安装 lua-language-server，并确保它位于 PATH。"),
  server("vue-language-server", [".vue"], "vue-language-server", ["--stdio"], ["package.json", "vite.config.ts", ".git"], "安装 @vue/language-server，并确保 vue-language-server 位于 PATH。"),
  server("yaml-language-server", [".yaml", ".yml"], "yaml-language-server", ["--stdio"], [".git"], "安装 yaml-language-server，并确保它位于 PATH。"),
];

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidOverride(value: LspServerOverride, serverId: string): boolean {
  return value.id === serverId
    && (!value.command || isNonBlankString(value.command))
    && (!value.args || value.args.every(isNonBlankString))
    && (!value.extensions || value.extensions.every((extension) => isNonBlankString(extension) && extension.startsWith(".")));
}

/**
 * 对磁盘中的用户配置做白名单规范化。这里不接受任意对象，避免配置文件把
 * 原型键或不可执行的参数传到子进程启动路径。
 */
export function normalizeLspServerOverrides(input: unknown): LspServerOverride[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const knownIds = new Set(BUILTIN_LSP_SERVERS.map((definition) => definition.id));
  const result: LspServerOverride[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    if (!isNonBlankString(raw.id) || !knownIds.has(raw.id) || seen.has(raw.id)) continue;
    const command = raw.command === undefined ? undefined : isNonBlankString(raw.command) ? raw.command.trim() : undefined;
    const args = Array.isArray(raw.args) && raw.args.every(isNonBlankString) ? raw.args.map((arg) => arg.trim()) : undefined;
    const extensions = Array.isArray(raw.extensions)
      && raw.extensions.every((extension) => isNonBlankString(extension) && extension.startsWith("."))
      ? raw.extensions.map((extension) => extension.trim().toLowerCase())
      : undefined;
    const initializationOptions = raw.initializationOptions !== undefined && isPlainJsonValue(raw.initializationOptions)
      ? raw.initializationOptions
      : undefined;
    if (raw.command !== undefined && !command) continue;
    if (raw.args !== undefined && !args) continue;
    if (raw.extensions !== undefined && !extensions) continue;
    result.push({ id: raw.id, ...(command ? { command } : {}), ...(args ? { args } : {}), ...(extensions ? { extensions } : {}), ...(initializationOptions !== undefined ? { initializationOptions } : {}) });
    seen.add(raw.id);
  }
  return result;
}

function isPlainJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(([key, nested]) =>
    key !== "__proto__" && key !== "prototype" && key !== "constructor" && isPlainJsonValue(nested));
}

function applyOverride(serverDefinition: LspServerDefinition, overrides: readonly LspServerOverride[]): LspServerDefinition {
  const override = overrides.find((candidate) => isValidOverride(candidate, serverDefinition.id));
  if (!override) return serverDefinition;
  return {
    ...serverDefinition,
    ...(override.extensions ? { extensions: [...override.extensions] } : {}),
    ...(override.command ? { commands: [{ command: override.command, args: override.args ? [...override.args] : [] }] } : {}),
    ...(override.initializationOptions !== undefined ? { initializationOptions: override.initializationOptions } : {}),
  };
}

export function findServerCandidates(
  filePath: string,
  overrides: readonly LspServerOverride[] = [],
): LspServerDefinition[] {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension) return [];
  return BUILTIN_LSP_SERVERS
    .filter((definition) => definition.extensions.includes(extension))
    .map((definition) => applyOverride(definition, overrides));
}
