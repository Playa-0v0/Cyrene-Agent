import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

describe("application update packaging", () => {
  it("packages GitHub update metadata for electron-updater downloads", () => {
    const config = load(readFileSync(resolve(process.cwd(), "electron-builder.yml"), "utf8")) as {
      publish?: { provider?: string; owner?: string; repo?: string };
    };

    expect(config.publish).toMatchObject({
      provider: "github",
      owner: "Playa-0v0",
      repo: "Cyrene-Agent",
    });
  });
});
