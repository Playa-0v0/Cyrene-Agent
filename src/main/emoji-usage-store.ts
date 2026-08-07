import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface EmojiUsageStore {
  schemaVersion: 1;
  usage: Record<string, number>;
}

let cache: EmojiUsageStore | null = null;

function getFilePath(): string {
  return path.join(app.getPath("userData"), "emoji-usage.json");
}

function emptyStore(): EmojiUsageStore {
  return { schemaVersion: 1, usage: {} };
}

function loadStore(): EmojiUsageStore {
  if (cache) return cache;
  const filePath = getFilePath();
  if (!fs.existsSync(filePath)) {
    cache = emptyStore();
    return cache;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as Partial<EmojiUsageStore>;
    if (data && typeof data === "object" && data.schemaVersion === 1 && data.usage) {
      cache = data as EmojiUsageStore;
    } else {
      cache = emptyStore();
    }
  } catch (err) {
    console.error("[EmojiUsageStore] Failed to load store, fallback to empty:", err);
    cache = emptyStore();
  }
  return cache;
}

function saveStore(): void {
  if (!cache) return;
  const filePath = getFilePath();
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error("[EmojiUsageStore] Failed to save store:", err);
  }
}

export function recordEmojiUse(emoji: string): void {
  const store = loadStore();
  store.usage[emoji] = (store.usage[emoji] ?? 0) + 1;
  saveStore();
}

/** Parses text for custom Discord emojis and Unicode emojis, and records their usage. */
export function recordEmojisFromText(text: string): void {
  if (!text) return;
  
  const store = loadStore();
  let updated = false;

  // 1. Discord custom emojis: <a?:name:id>
  const discordEmojiRegex = /<a?:([a-zA-Z0-9_]+):[0-9]+>/g;
  let match;
  while ((match = discordEmojiRegex.exec(text)) !== null) {
    const name = match[1];
    store.usage[name] = (store.usage[name] ?? 0) + 1;
    updated = true;
  }

  // 2. Unicode emojis
  // A comprehensive regex for Unicode emojis
  const unicodeEmojiRegex = /[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;
  const unicodeMatches = text.match(unicodeEmojiRegex);
  if (unicodeMatches) {
    for (const emoji of unicodeMatches) {
      store.usage[emoji] = (store.usage[emoji] ?? 0) + 1;
      updated = true;
    }
  }

  if (updated) {
    saveStore();
  }
}

export function getEmojiUsage(): Record<string, number> {
  const store = loadStore();
  return { ...store.usage };
}
