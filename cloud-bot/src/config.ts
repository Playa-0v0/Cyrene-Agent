export type CloudBotConfig = {
  discordToken: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  allowedUserIds: Set<string>;
  allowedGuildIds: Set<string>;
  allowedChannelIds: Set<string>;
  requireMention: boolean;
  dataDir: string;
  port: number;
  historyMessages: number;
  activity: string;
  systemPromptFile?: string;
};

export function parseIdList(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`缺少必要環境變數：${key}`);
  return value;
}

function requiredAny(env: NodeJS.ProcessEnv, keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`缺少必要環境變數：${keys.join(" 或 ")}`);
}

function parseIntInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudBotConfig {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  return {
    discordToken: required(env, "DISCORD_BOT_TOKEN"),
    llmApiKey: requiredAny(env, ["LLM_API_KEY", "OPENROUTER_API_KEY"]),
    llmBaseUrl: (env.LLM_BASE_URL?.trim() || (openRouterKey ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).replace(/\/+$/, ""),
    llmModel: env.LLM_MODEL?.trim() || (openRouterKey ? "openrouter/free" : "gpt-4.1-mini"),
    allowedUserIds: parseIdList(env.DISCORD_ALLOWED_USER_IDS),
    allowedGuildIds: parseIdList(env.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannelIds: parseIdList(env.DISCORD_ALLOWED_CHANNEL_IDS),
    requireMention: env.DISCORD_REQUIRE_MENTION?.trim().toLowerCase() !== "false",
    dataDir: env.DATA_DIR?.trim() || "./data",
    port: parseIntInRange(env.PORT, 3000, 1, 65_535),
    historyMessages: parseIntInRange(env.HISTORY_MESSAGES, 20, 4, 40),
    activity: env.BOT_ACTIVITY?.trim() || "在雲端守望永晝花庭",
    systemPromptFile: env.BOT_SYSTEM_PROMPT_FILE?.trim() || undefined,
  };
}
