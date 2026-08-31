import { createHash } from "crypto";

const CACHE_KEY_PREFIX = /^(minimax|gptsovits|custom-cloud|mimo|mossland)-/;

/** Adds the speech converter version without losing compound provider prefixes. */
export function versionTtsCacheKey(cacheKey: string, converterVersion: string): string {
  const prefix = CACHE_KEY_PREFIX.exec(cacheKey)?.[1] ?? "tts";
  const digest = createHash("sha256")
    .update(`${cacheKey}\0${converterVersion}`, "utf8")
    .digest("hex");
  return `${prefix}-${digest}`;
}
