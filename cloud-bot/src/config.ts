export type CloudBotConfig = {
  discordToken: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  /** 有圖片時使用的 OpenRouter／OpenAI 相容模型；未設定則沿用 llmModel。 */
  llmVisionModel: string;
  /** OpenRouter 免費額度耗盡時使用的 Google Gemini OpenAI 相容端點。 */
  geminiApiKey?: string;
  geminiBaseUrl: string;
  geminiModel: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRefreshToken?: string;
  allowedUserIds: Set<string>;
  allowedGuildIds: Set<string>;
  allowedChannelIds: Set<string>;
  requireMention: boolean;
  dataDir: string;
  port: number;
  historyMessages: number;
  maxOutputTokens: number;
  musicMonthlyMinutes: number;
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
  const allowedUserIds = parseIdList(required(env, "DISCORD_ALLOWED_USER_IDS"));
  if (!allowedUserIds.size) throw new Error("DISCORD_ALLOWED_USER_IDS 至少要包含一個 Discord User ID");
  return {
    discordToken: required(env, "DISCORD_BOT_TOKEN"),
    llmApiKey: requiredAny(env, ["LLM_API_KEY", "OPENROUTER_API_KEY"]),
    llmBaseUrl: (env.LLM_BASE_URL?.trim() || (openRouterKey ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")).replace(/\/+$/, ""),
    llmModel: env.LLM_MODEL?.trim() || (openRouterKey ? "openrouter/free" : "gpt-4.1-mini"),
    llmVisionModel: env.LLM_VISION_MODEL?.trim() || env.LLM_MODEL?.trim() || (openRouterKey ? "openrouter/free" : "gpt-4.1-mini"),
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    geminiBaseUrl: (env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
    spotifyClientId: env.SPOTIFY_CLIENT_ID?.trim() || undefined,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() || undefined,
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN?.trim() || undefined,
    allowedUserIds,
    allowedGuildIds: parseIdList(env.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannelIds: parseIdList(env.DISCORD_ALLOWED_CHANNEL_IDS),
    requireMention: env.DISCORD_REQUIRE_MENTION?.trim().toLowerCase() !== "false",
    dataDir: env.DATA_DIR?.trim() || "./data",
    port: parseIntInRange(env.PORT, 3000, 1, 65_535),
    historyMessages: parseIntInRange(env.HISTORY_MESSAGES, 8, 4, 20),
    maxOutputTokens: parseIntInRange(env.MAX_OUTPUT_TOKENS, 500, 64, 1_000),
    musicMonthlyMinutes: parseIntInRange(env.CLOUD_MUSIC_MONTHLY_MINUTES, 300, 30, 600),
    activity: env.BOT_ACTIVITY?.trim() || "在雲端守望永晝花庭",
    systemPromptFile: env.BOT_SYSTEM_PROMPT_FILE?.trim() || undefined,
  };
}
