import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface DiscordAchievementStats {
  firstMetTimestamp: number;
  messagesCount: number;
  musicTracksPlayed: number;
  checkinsCount: number;
  checkinStreak: number;
  lastCheckinDate: string;
  unlockedBadges: string[];
}

const DEFAULT_STATS: DiscordAchievementStats = {
  firstMetTimestamp: Date.now(),
  messagesCount: 1,
  musicTracksPlayed: 0,
  checkinsCount: 0,
  checkinStreak: 0,
  lastCheckinDate: "",
  unlockedBadges: ["🌸 初次相遇"],
};

export function getAchievementsFilePath(): string {
  return path.join(app.getPath("userData"), "discord", "achievements.json");
}

export function loadAchievementStats(filePath = getAchievementsFilePath()): DiscordAchievementStats {
  try {
    if (!fs.existsSync(filePath)) return { ...DEFAULT_STATS, firstMetTimestamp: Date.now() };
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as Partial<DiscordAchievementStats>;
    const checkinsCount = typeof data.checkinsCount === "number" ? data.checkinsCount : 0;
    const legacyCheckinDate = checkinsCount > 0
      ? taipeiDateKey(fs.statSync(filePath).mtimeMs)
      : "";
    return {
      firstMetTimestamp: typeof data.firstMetTimestamp === "number" ? data.firstMetTimestamp : Date.now(),
      messagesCount: typeof data.messagesCount === "number" ? data.messagesCount : 1,
      musicTracksPlayed: typeof data.musicTracksPlayed === "number" ? data.musicTracksPlayed : 0,
      checkinsCount,
      checkinStreak: typeof data.checkinStreak === "number"
        ? data.checkinStreak
        : (checkinsCount > 0 ? 1 : 0),
      lastCheckinDate: typeof data.lastCheckinDate === "string"
        ? data.lastCheckinDate
        : legacyCheckinDate,
      unlockedBadges: Array.isArray(data.unlockedBadges) ? data.unlockedBadges : ["🌸 初次相遇"],
    };
  } catch {
    return { ...DEFAULT_STATS, firstMetTimestamp: Date.now() };
  }
}

export function saveAchievementStats(stats: DiscordAchievementStats, filePath = getAchievementsFilePath()): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(stats, null, 2), "utf8");
  } catch (err) {
    console.warn("[DiscordAchievements] 寫入統計失敗:", err);
  }
}

export function recordAchievementEvent(
  type: "message" | "music" | "checkin",
  filePath = getAchievementsFilePath(),
  now = Date.now(),
): DiscordAchievementStats {
  const stats = loadAchievementStats(filePath);
  if (type === "message") stats.messagesCount += 1;
  if (type === "music") stats.musicTracksPlayed += 1;
  if (type === "checkin") {
    const dateKey = taipeiDateKey(now);
    if (stats.lastCheckinDate !== dateKey) {
      const previousDateKey = taipeiDateKey(now - 86_400_000);
      stats.checkinStreak = stats.lastCheckinDate === previousDateKey
        ? Math.max(1, stats.checkinStreak + 1)
        : 1;
      stats.checkinsCount += 1;
      stats.lastCheckinDate = dateKey;
    }
  }

  // 檢查解鎖成就
  const badges = new Set(stats.unlockedBadges);
  badges.add("🌸 初次相遇");

  const daysTogether = Math.max(1, Math.floor((Date.now() - stats.firstMetTimestamp) / 86_400_000));
  if (daysTogether >= 7) badges.add("💖 相伴一週");
  if (daysTogether >= 30) badges.add("✨ 陪伴滿月");
  if (stats.messagesCount >= 50) badges.add("💬 健談夥伴");
  if (stats.messagesCount >= 200) badges.add("💌 知心好友");
  if (stats.musicTracksPlayed >= 10) badges.add("🎵 音樂隨行");
  if (stats.musicTracksPlayed >= 50) badges.add("🎧 駐場DJ");
  if (stats.checkinsCount >= 5) badges.add("☀️ 勤奮簽到");

  stats.unlockedBadges = [...badges];
  saveAchievementStats(stats, filePath);
  return stats;
}

function taipeiDateKey(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
