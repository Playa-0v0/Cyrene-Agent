import { describe, it, expect, beforeEach } from "vitest";
import { buildChildEnv } from "./child-env";

const ORIGINAL: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  SystemRoot: "C:/Windows",
  WINDIR: "C:/Windows",
  TEMP: "/tmp",
  USERPROFILE: "/home/u",
  HOME: "/home/u",
  LANG: "en",
  MINIMAX_API_KEY: "SECRET",
  EMAIL_PASSWORD: "SECRET",
  HTTP_PROXY: "http://proxy:8080",
};

beforeEach(() => {
  process.env = { ...ORIGINAL };
});

describe("buildChildEnv", () => {
  it("passes through allowed keys", () => {
    const env = buildChildEnv({ CYRENE_MUSIC_STORAGE_DIR: "/tmp/x" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SystemRoot).toBe("C:/Windows");
    expect(env.HTTP_PROXY).toBe("http://proxy:8080");
    expect(env.CYRENE_MUSIC_STORAGE_DIR).toBe("/tmp/x");
  });

  it("drops disallowed secrets", () => {
    const env = buildChildEnv({});
    expect(env.MINIMAX_API_KEY).toBeUndefined();
    expect(env.EMAIL_PASSWORD).toBeUndefined();
  });

  it("lets extra keys override allow-listed ones", () => {
    const env = buildChildEnv({ PATH: "/custom/bin" });
    expect(env.PATH).toBe("/custom/bin");
  });
});
