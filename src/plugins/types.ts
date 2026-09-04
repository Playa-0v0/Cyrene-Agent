import type { PluginManifest } from "./api";

export * from "./api";

export type PluginSource = "builtin" | "user";

export interface PluginRecord {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  /** Manifest + entry stat fingerprint used by rescan/reload. */
  fingerprint: string;
}
