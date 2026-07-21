import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_CHAT_REQUEST_TIMEOUT_MS, DEFAULT_FORCE_SUMMARY_TIMEOUT_MS, DEFAULT_MEMORY_JUDGE_MS, DEFAULT_PER_ROUND_TIMEOUT_MS, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_SETTINGS, DEFAULT_VISION_TIMEOUT_MS, type TimeoutSettings } from "../shared/timeout-types";

let cachedTimeoutSettings: TimeoutSettings | null = null;

function getTimeoutSettingsPath(): string {
  return path.join(app.getPath("userData"), "timeout-settings.json");
}

function normalizeTimeoutSettings(input: Partial<TimeoutSettings> | null | undefined): TimeoutSettings {
  return {
    callTimeout: input?.callTimeout || DEFAULT_CALL_TIMEOUT_MS,
    testTimeout: input?.testTimeout || 15000,
    perRoundTimeout: input?.perRoundTimeout || DEFAULT_PER_ROUND_TIMEOUT_MS,
    forceSummaryTimeout: input?.forceSummaryTimeout || DEFAULT_FORCE_SUMMARY_TIMEOUT_MS,
    chatRequestTimeout: input?.chatRequestTimeout || DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
    memoryJudgeTimeout: input?.memoryJudgeTimeout || DEFAULT_MEMORY_JUDGE_MS,
    visionTimeout: input?.visionTimeout || DEFAULT_VISION_TIMEOUT_MS,
    userChoiceTimeout: input?.userChoiceTimeout || 60000,
    searchTimeout: input?.searchTimeout || DEFAULT_SEARCH_TIMEOUT_MS,
  };
}

function loadTimeoutSettings(): TimeoutSettings {
  try {
    const filePath = getTimeoutSettingsPath();
    if (!fs.existsSync(filePath)) return { ...DEFAULT_TIMEOUT_SETTINGS };
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeTimeoutSettings(JSON.parse(raw) as Partial<TimeoutSettings>);
  } catch (err) {
    console.error("[Cyrene] load settings failed:", err);
    return { ...DEFAULT_TIMEOUT_SETTINGS };
  }
}

export function getTimeoutSettings(): TimeoutSettings {
  if (cachedTimeoutSettings !== null) return cachedTimeoutSettings;
  return cachedTimeoutSettings = loadTimeoutSettings();
}

export function saveTimeoutSettings(settings: Partial<TimeoutSettings>): TimeoutSettings {
  const finalTimeoutSettings = getTimeoutSettings();
  Object.assign(finalTimeoutSettings, settings);
  const filePath = getTimeoutSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(finalTimeoutSettings, null, 2), "utf8");
  return finalTimeoutSettings;
}
