import type { ScheduleConfig } from "./types";

function parseTimeOfDay(timeOfDay: string): { hours: number; minutes: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function atLocalTime(base: Date, timeOfDay: string): Date | null {
  const parsed = parseTimeOfDay(timeOfDay);
  if (!parsed) return null;
  const out = new Date(base);
  out.setHours(parsed.hours, parsed.minutes, 0, 0);
  return out;
}

function intervalMs(schedule: Extract<ScheduleConfig, { kind: "interval" }>): number {
  const unitMs = schedule.unit === "minutes" ? 60_000 : 3_600_000;
  return schedule.every * unitMs;
}

function normalizeOverdueInterval(
  schedule: Extract<ScheduleConfig, { kind: "interval" }>,
  currentNextFireAt: Date,
  now: Date,
): Date | null {
  const step = intervalMs(schedule);
  if (step <= 0) return null;
  const missed = Math.floor((now.getTime() - currentNextFireAt.getTime()) / step) + 1;
  return new Date(currentNextFireAt.getTime() + missed * step);
}

export function computeInitialNextFireAt(schedule: ScheduleConfig, now: Date): Date | null {
  switch (schedule.kind) {
    case "once": {
      const runAt = new Date(schedule.runAt);
      if (Number.isNaN(runAt.getTime()) || runAt.getTime() <= now.getTime()) return null;
      return runAt;
    }
    case "daily": {
      const today = atLocalTime(now, schedule.timeOfDay);
      if (!today) return null;
      if (today.getTime() > now.getTime()) return today;
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    }
    case "weekly": {
      const candidate = atLocalTime(now, schedule.timeOfDay);
      if (!candidate) return null;
      const daysAhead = (schedule.dayOfWeek - now.getDay() + 7) % 7;
      candidate.setDate(candidate.getDate() + daysAhead);
      if (candidate.getTime() > now.getTime()) return candidate;
      candidate.setDate(candidate.getDate() + 7);
      return candidate;
    }
    case "interval": {
      if (!Number.isInteger(schedule.every) || schedule.every <= 0) return null;
      return new Date(now.getTime() + intervalMs(schedule));
    }
  }
}

export function computeNextFireAtAfter(schedule: ScheduleConfig, scheduledFireAt: Date): Date | null {
  switch (schedule.kind) {
    case "once":
      return null;
    case "daily": {
      const next = new Date(scheduledFireAt);
      next.setDate(next.getDate() + 1);
      return next;
    }
    case "weekly": {
      const next = new Date(scheduledFireAt);
      next.setDate(next.getDate() + 7);
      return next;
    }
    case "interval": {
      if (!Number.isInteger(schedule.every) || schedule.every <= 0) return null;
      return new Date(scheduledFireAt.getTime() + intervalMs(schedule));
    }
  }
}

export function normalizeOverdueNextFireAt(
  schedule: ScheduleConfig,
  currentNextFireAt: Date,
  now: Date,
): Date | null {
  if (currentNextFireAt.getTime() > now.getTime()) return currentNextFireAt;
  if (schedule.kind === "once") return null;
  if (schedule.kind === "interval") return normalizeOverdueInterval(schedule, currentNextFireAt, now);

  let cursor: Date | null = currentNextFireAt;
  let guard = 0;
  while (cursor && cursor.getTime() <= now.getTime() && guard < 10_000) {
    cursor = computeNextFireAtAfter(schedule, cursor);
    guard += 1;
  }
  return cursor && cursor.getTime() > now.getTime() ? cursor : computeInitialNextFireAt(schedule, now);
}
