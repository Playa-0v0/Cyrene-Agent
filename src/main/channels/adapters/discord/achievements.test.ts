import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordAchievementEvent } from "./achievements";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempStatsFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-checkin-"));
  tempDirs.push(dir);
  return path.join(dir, "achievements.json");
}

describe("Discord 每日簽到", () => {
  it("同一個台北日期只計入一次", () => {
    const file = tempStatsFile();
    const morning = Date.parse("2026-08-05T00:15:00+08:00");
    const evening = Date.parse("2026-08-05T23:30:00+08:00");

    const first = recordAchievementEvent("checkin", file, morning);
    const repeated = recordAchievementEvent("checkin", file, evening);

    expect(first.checkinsCount).toBe(1);
    expect(repeated.checkinsCount).toBe(1);
    expect(repeated.checkinStreak).toBe(1);
    expect(repeated.lastCheckinDate).toBe("2026-08-05");
  });

  it("隔天問候會增加連續天數，漏一天則重新計算", () => {
    const file = tempStatsFile();
    recordAchievementEvent("checkin", file, Date.parse("2026-08-03T08:00:00+08:00"));
    const nextDay = recordAchievementEvent("checkin", file, Date.parse("2026-08-04T08:00:00+08:00"));
    const afterGap = recordAchievementEvent("checkin", file, Date.parse("2026-08-06T08:00:00+08:00"));

    expect(nextDay.checkinStreak).toBe(2);
    expect(afterGap.checkinsCount).toBe(3);
    expect(afterGap.checkinStreak).toBe(1);
  });
});
