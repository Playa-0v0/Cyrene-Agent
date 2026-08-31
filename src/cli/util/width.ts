/**
 * Display width of a string, in terminal cells.
 *
 * v0.9 scope: the banner contains only ASCII + a small set of box-drawing
 * characters and ♡, all of which are 1 cell wide in every monospace font we
 * target. So v0.9 uses a simple code-unit count via Array.from().
 *
 * This is a known limitation, not a bug: CJK characters (2 cells) are not in
 * the v0.9 banner. The function is named `displayWidth` (not `visibleWidth`
 * or `graphemeLength`) so a v1.x UAX #11 (East Asian Width) implementation
 * can replace the body without renaming callers.
 */
export function displayWidth(s: string): number {
  return Array.from(s).length;
}
