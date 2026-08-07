import * as fs from "node:fs";
import * as path from "node:path";

export type CloudCheckinStats = {
  total: number;
  streak: number;
  lastDate: string;
};

const EMPTY_STATS: CloudCheckinStats = { total: 0, streak: 0, lastDate: "" };

function taipeiDateKey(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isCloudCheckinGreeting(text: string): boolean {
  return /^(?:簽到|每日簽到|打卡|簽個到|早安|晚安|午安|早上好|下午好|中午好|晚上好|安安|早呀|晚安呀|早安安|晚安安|睡前問候)$/ui.test(text.trim());
}

export class CloudCheckinStore {
  constructor(private readonly filePath: string) {}

  load(): CloudCheckinStats {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<CloudCheckinStats>;
      return {
        total: typeof value.total === "number" ? value.total : 0,
        streak: typeof value.streak === "number" ? value.streak : 0,
        lastDate: typeof value.lastDate === "string" ? value.lastDate : "",
      };
    } catch {
      return { ...EMPTY_STATS };
    }
  }

  record(now = Date.now()): CloudCheckinStats {
    const stats = this.load();
    const today = taipeiDateKey(now);
    if (stats.lastDate === today) return stats;
    const yesterday = taipeiDateKey(now - 86_400_000);
    stats.streak = stats.lastDate === yesterday ? Math.max(1, stats.streak + 1) : 1;
    stats.total += 1;
    stats.lastDate = today;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(stats, null, 2), { encoding: "utf8", mode: 0o600 });
    return stats;
  }
}
