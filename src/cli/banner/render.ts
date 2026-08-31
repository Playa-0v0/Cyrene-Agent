/**
 * Composes the ASCII logo and the framed text block into a single string.
 * No color, no ANSI escapes. The frame uses only ╭ ─ │ ╰ ╯.
 */
import process from "node:process";
import { CYRENE_LOGO, CYRENE_LOGO_TEXT } from "./ascii.js";
import {
  ABOUT_LINES,
  BANNER_LINES,
  DEFAULT_BANNER_WIDTH,
  MIN_BANNER_WIDTH,
  type RenderOptions,
} from "./text.js";
import { displayWidth } from "../util/width.js";

/** Resolve the effective box width from options / tty / defaults. */
export function resolveWidth(opts?: RenderOptions): number {
  if (opts?.width !== undefined) {
    return Math.max(MIN_BANNER_WIDTH, opts.width);
  }
  const cols = typeof process.stdout.columns === "number" ? process.stdout.columns : 0;
  if (cols >= MIN_BANNER_WIDTH) return cols;
  return DEFAULT_BANNER_WIDTH;
}

/**
 * Center `text` inside a field of `width` cells, padding with spaces.
 * If the text is too long, truncate with a trailing ellipsis.
 */
function center(text: string, width: number): string {
  const inner = width - 4; // two spaces of padding on each side inside │ ... │
  if (displayWidth(text) > inner) {
    // Truncate to inner - 1 and add …
    const chars = Array.from(text);
    return chars.slice(0, inner - 1).join("") + "…";
  }
  const pad = inner - displayWidth(text);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

/** Build the framed box for the given lines at the given width. */
function frameBox(lines: readonly string[], width: number): string {
  const dash = "─".repeat(width - 2);
  const top = "╭" + dash + "╮";
  const bottom = "╰" + dash + "╯";
  const rows = lines.map((l) => "│ " + center(l, width) + " │");
  return [top, ...rows, bottom].join("\n");
}

/** The full banner: logo + blank line + framed box. */
export function renderBanner(opts?: RenderOptions): string {
  const width = resolveWidth(opts);
  return CYRENE_LOGO_TEXT + "\n\n" + frameBox(BANNER_LINES, width);
}

/** The banner plus an extra framed block with project metadata. */
export function renderAbout(opts?: RenderOptions): string {
  const width = resolveWidth(opts);
  return renderBanner(opts) + "\n\n" + frameBox(ABOUT_LINES, width);
}

/** Re-export for tests that want to assert on the raw logo lines. */
export { CYRENE_LOGO };
