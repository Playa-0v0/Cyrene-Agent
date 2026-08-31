/**
 * The three fixed lines shown inside the banner frame.
 * The quote is the Cyrene brand line; it is intentionally not the version.
 */
export const BANNER_LINES = [
  "♡ Cyrene Agent ♡",
  "Your Desktop AI Companion",
  '"Every memory has a place."',
] as const;

export const ABOUT_LINES = [
  "GitHub:   https://github.com/Playa-0v0/Cyrene-Agent",
  "License:  MIT (see MODEL_LICENSE.md for model terms)",
] as const;

/** Default framed-box width when the terminal width is unknown or too narrow. */
export const DEFAULT_BANNER_WIDTH = 64;
/** Minimum framed-box width. Below this, the box would not fit the quote. */
export const MIN_BANNER_WIDTH = 60;

export interface RenderOptions {
  /**
   * Reserved for v1.x. v0.9 always uses BANNER_LINES[2].
   * Not read; kept on the type so callers do not need to change later.
   */
  quote?: string;
  /** Override the auto-detected width (mainly for tests). */
  width?: number;
}
