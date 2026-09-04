import type {
  PluginPromptBuildInput,
  PluginPromptProvider,
} from "./types";

const PROMPT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS = 2_000;
export const MAX_PLUGIN_PROMPT_CHARS = 16_000;
export const MAX_PLUGIN_PROMPT_TOTAL_CHARS = 32_000;

interface PromptEntry {
  ownerId: string;
  provider: PluginPromptProvider;
  signal: AbortSignal;
}

export interface PluginPromptRegistry {
  register(ownerId: string, provider: PluginPromptProvider, signal: AbortSignal): void;
  unregister(ownerId: string, providerId: string): boolean;
  build(input: PluginPromptBuildInput): Promise<string>;
  clear(): void;
}

function fullProviderId(ownerId: string, providerId: string): string {
  return `plugin:${ownerId}:${providerId}`;
}

/** 单个 Provider 失败或超时时返回空内容，避免第三方插件阻塞整轮对话。 */
async function resolveProvider(entry: PromptEntry, input: PluginPromptBuildInput): Promise<string> {
  const fullId = fullProviderId(entry.ownerId, entry.provider.id);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      Promise.resolve(entry.provider.provide({ ...input, signal: entry.signal })),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`提示词 Provider 超时（${PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS}ms）`));
        }, PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS);
      }),
    ]);
    if (typeof content !== "string") {
      throw new Error("提示词 Provider 必须返回字符串");
    }
    const normalized = content.trim();
    if (!normalized) return "";
    if (normalized.length > MAX_PLUGIN_PROMPT_CHARS) {
      console.warn(`[plugins] ${fullId} 提示词超过 ${MAX_PLUGIN_PROMPT_CHARS} 字符，已截断`);
      return normalized.slice(0, MAX_PLUGIN_PROMPT_CHARS);
    }
    return normalized;
  } catch (error) {
    console.warn(`[plugins] ${fullId} 提示词生成失败，已跳过`, error);
    return "";
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export function createPluginPromptRegistry(): PluginPromptRegistry {
  const entries = new Map<string, PromptEntry>();

  return {
    register(ownerId, provider, signal) {
      if (!provider || typeof provider !== "object") {
        throw new Error("插件提示词 Provider 必须是对象");
      }
      if (!PROMPT_ID_RE.test(provider.id)) {
        throw new Error(`非法插件提示词 Provider id: ${provider.id}`);
      }
      if (typeof provider.provide !== "function") {
        throw new Error("插件提示词 Provider 必须提供 provide() 函数");
      }
      if (provider.modes && (
        !Array.isArray(provider.modes)
        || provider.modes.some((mode) => !["chat", "work", "learn", "code"].includes(mode))
      )) {
        throw new Error("插件提示词 Provider modes 含未知模式");
      }
      const fullId = fullProviderId(ownerId, provider.id);
      if (entries.has(fullId)) {
        throw new Error(`插件提示词 Provider 已注册: ${provider.id}`);
      }
      entries.set(fullId, { ownerId, provider, signal });
    },

    unregister(ownerId, providerId) {
      return entries.delete(fullProviderId(ownerId, providerId));
    },

    async build(input) {
      // 先拍快照再并行执行：结果仍按注册顺序拼接，运行中增删不会改变本轮内容。
      const snapshot = [...entries.values()].filter((entry) => (
        !entry.signal.aborted
        && (!entry.provider.modes || entry.provider.modes.includes(input.mode))
      ));
      const contents = await Promise.all(snapshot.map((entry) => resolveProvider(entry, input)));
      const blocks: string[] = [];
      let totalChars = 0;
      for (let index = 0; index < snapshot.length; index += 1) {
        const content = contents[index];
        if (!content) continue;
        const fullId = fullProviderId(snapshot[index].ownerId, snapshot[index].provider.id);
        const separator = blocks.length > 0 ? "\n\n---\n\n" : "";
        const header = `[插件上下文：${fullId}]\n`;
        const remaining = MAX_PLUGIN_PROMPT_TOTAL_CHARS - totalChars - separator.length - header.length;
        if (remaining <= 0) {
          console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已忽略后续内容`);
          break;
        }
        const accepted = content.slice(0, remaining);
        blocks.push(separator + header + accepted);
        totalChars += separator.length + header.length + accepted.length;
        if (accepted.length < content.length) {
          console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已截断`);
          break;
        }
      }
      return blocks.join("");
    },

    clear() {
      entries.clear();
    },
  };
}

export const pluginPromptRegistry = createPluginPromptRegistry();
