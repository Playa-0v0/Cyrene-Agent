import { app } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  normalizeChatMessagesWithTime,
  type ChatContextMessage,
} from "./chat-time-context";

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function normalizeChatMessages(input: unknown): ChatContextMessage[] {
  return normalizeChatMessagesWithTime(input);
}

export function getApiLogPath(): string {
  return path.join(app.getPath("userData"), "chat-api.log");
}

export function appendApiLog(
  label: string,
  requestMessages: Array<{ role: string; content: string }>,
  rawResponse: string,
  cleanedResponse: string,
): void {
  try {
    const now = new Date().toISOString();
    const entry = [
      "=".repeat(80),
      `[${now}] ${label}`,
      "-".repeat(40) + " REQUEST " + "-".repeat(40),
      JSON.stringify(requestMessages, null, 2),
      "-".repeat(40) + " RAW RESPONSE " + "-".repeat(40),
      rawResponse,
      "-".repeat(40) + " CLEANED " + "-".repeat(40),
      cleanedResponse || "(empty)",
      "=".repeat(80),
      "",
    ].join(os.EOL);
    fs.appendFileSync(getApiLogPath(), entry, "utf8");
  } catch {
    // silent
  }
}
