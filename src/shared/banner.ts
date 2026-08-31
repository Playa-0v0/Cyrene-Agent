/**
 * The Cyrene ASCII banner, shared between the CLI and the Electron main
 * process so both startup paths show the same branding.
 *
 * Kept color-free by design: the banner is a brand artifact, not a log
 * line. Logger output (which may be colored) is a separate concern.
 */
export const CYRENE_LOGO = [
  "██████╗██╗   ██╗██████╗ ███████╗███╗   ██╗███████╗",
  "██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝████╗  ██║██╔════╝",
  "██║      ╚████╔╝ ██████╔╝█████╗  ██╔██╗ ██║█████╗",
  "██║       ╚██╔╝  ██╔══██╗██╔══╝  ██║╚██╗██║██╔══╝",
  "╚██████╗   ██║   ██║  ██║███████╗██║ ╚████║███████╗",
  " ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝",
] as const;

export const BANNER_LINES = [
  "♡ Cyrene Agent ♡",
  "Your Desktop AI Companion",
  '"Every memory has a place."',
] as const;

/** The framed box width used when the terminal width is unknown. */
export const DEFAULT_BANNER_WIDTH = 64;
export const MIN_BANNER_WIDTH = 60;

function displayWidth(s: string): number {
  return Array.from(s).length;
}

function center(text: string, width: number): string {
  const inner = width - 4;
  if (displayWidth(text) > inner) {
    return Array.from(text).slice(0, inner - 1).join("") + "…";
  }
  const pad = inner - displayWidth(text);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function frameBox(lines: readonly string[], width: number): string {
  const dash = "─".repeat(width - 2);
  const top = "╭" + dash + "╮";
  const bottom = "╰" + dash + "╯";
  const rows = lines.map((l) => "│ " + center(l, width) + " │");
  return [top, ...rows, bottom].join("\n");
}

/** The full banner: logo + blank line + framed box. No color, no log prefix. */
export function renderBanner(): string {
  return CYRENE_LOGO.join("\n") + "\n\n" + frameBox(BANNER_LINES, DEFAULT_BANNER_WIDTH);
}
