import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * Uses atomic file creation so duplicate bot processes sharing the same data
 * volume cannot acknowledge the same Discord event twice.
 */
export class EventClaimStore {
  private readonly directory: string;

  constructor(dataDirectory: string, namespace = "discord-events") {
    this.directory = path.join(dataDirectory, namespace);
    mkdirSync(this.directory, { recursive: true });
  }

  claim(eventId: string): boolean {
    const safeId = eventId.replace(/[^a-zA-Z0-9_-]/g, "_");
    try {
      const descriptor = openSync(path.join(this.directory, safeId), "wx");
      closeSync(descriptor);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  prune(maxAgeMs = 24 * 60 * 60 * 1_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(this.directory)) {
      const file = path.join(this.directory, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
        // Another process may prune the same claim concurrently.
      }
    }
  }
}
