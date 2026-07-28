import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type UsageFile = { month: string; minutes: number };

function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export class MusicUsageStore {
  private state: UsageFile = { month: currentMonth(), minutes: 0 };

  constructor(private readonly filePath: string, private readonly monthlyLimit: number) {}

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<UsageFile>;
      if (typeof parsed.month === "string" && typeof parsed.minutes === "number") {
        this.state = { month: parsed.month, minutes: Math.max(0, Math.floor(parsed.minutes)) };
      }
    } catch { /* 第一次啟動 */ }
    this.rollover();
  }

  used(): number {
    this.rollover();
    return this.state.minutes;
  }

  remaining(): number {
    return Math.max(0, this.monthlyLimit - this.used());
  }

  exhausted(): boolean {
    return this.remaining() <= 0;
  }

  async addMinute(): Promise<number> {
    this.rollover();
    this.state.minutes += 1;
    await this.flush();
    return this.remaining();
  }

  private rollover(): void {
    const month = currentMonth();
    if (this.state.month !== month) this.state = { month, minutes: 0 };
  }

  private async flush(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
