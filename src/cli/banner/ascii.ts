/**
 * ANSI Shadow rendering of "CYRENE". Six lines, monospace-only.
 * Committed verbatim so the banner is byte-for-byte deterministic across releases.
 */
export const CYRENE_LOGO = [
  "██████╗██╗   ██╗██████╗ ███████╗███╗   ██╗███████╗",
  "██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝████╗  ██║██╔════╝",
  "██║      ╚████╔╝ ██████╔╝█████╗  ██╔██╗ ██║█████╗",
  "██║       ╚██╔╝  ██╔══██╗██╔══╝  ██║╚██╗██║██╔══╝",
  "╚██████╗   ██║   ██║  ██║███████╗██║ ╚████║███████╗",
  " ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝",
] as const;

export const CYRENE_LOGO_TEXT = CYRENE_LOGO.join("\n");
