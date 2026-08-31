/**
 * Core leveled logger — no Electron dependency. Both the main process and
 * pure modules (skill-scanner, etc.) use this.
 *
 * Format:  HH:MM:SS.mmm LEVEL  Tag           message
 * Levels:  debug < info < warn < error
 *
 * Color: applied when stdout is a TTY and NO_COLOR is unset.
 * Override the default via CYRENE_LOG_LEVEL=debug|info|warn|error.
 *
 * This file is the single source of truth for log formatting. The Electron
 * main process wraps it (see src/main/logger.ts) to add the `app.isPackaged`
 * default-level heuristic; that wrapper just calls setLogLevel() once.
 */
import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.white,
  warn: ANSI.yellow,
  error: ANSI.red,
};

let currentLevel: LogLevel = readEnvLevel() ?? "info";

function readEnvLevel(): LogLevel | null {
  const env = process.env.CYRENE_LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") return env;
  return null;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function padTag(tag: string): string {
  return tag.length >= 16 ? tag.slice(0, 16) : tag + " ".repeat(16 - tag.length);
}

function stringify(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function emit(level: LogLevel, tag: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const message = args.map(stringify).join(" ");
  const lvl = level.toUpperCase().padEnd(5);
  const tagCol = padTag(tag);

  if (useColor()) {
    const c = LEVEL_COLOR[level];
    const line = `${c}${lvl}${ANSI.reset} ${tagCol} ${message}`;
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  } else {
    const line = `${lvl} ${tagCol} ${message}`;
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  }
}

export const logger = {
  debug: (tag: string, ...args: unknown[]) => emit("debug", tag, args),
  info: (tag: string, ...args: unknown[]) => emit("info", tag, args),
  warn: (tag: string, ...args: unknown[]) => emit("warn", tag, args),
  error: (tag: string, ...args: unknown[]) => emit("error", tag, args),
};

export { LogTag, type LogTagKey } from "./logger-tags";
