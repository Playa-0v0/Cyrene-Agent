import { describe, expect, it, vi } from "vitest";
import { resolveGitExecutable } from "./git-executable";

describe("resolveGitExecutable", () => {
  it("prefers a working system Git over bundled MinGit", async () => {
    const probe = vi.fn(async (candidate: string) =>
      candidate === "git" ? "git version 2.55.0.windows.3" : "git version 2.55.0.windows.3",
    );

    const executable = await resolveGitExecutable({
      systemCommand: "git",
      bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      probe,
    });

    expect(executable).toMatchObject({
      command: "git",
      source: "system",
      version: "2.55.0.windows.3",
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("uses isolated bundled MinGit only when system Git is unavailable", async () => {
    const probe = vi.fn(async (candidate: string) =>
      candidate === "git" ? null : "git version 2.55.0.windows.3",
    );

    const executable = await resolveGitExecutable({
      systemCommand: "git",
      bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      probe,
    });

    expect(executable).toMatchObject({
      command: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      source: "bundled",
      version: "2.55.0.windows.3",
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "NUL",
      },
    });
    expect(probe).toHaveBeenNthCalledWith(1, "git");
    expect(probe).toHaveBeenNthCalledWith(2, "C:\\app\\resources\\mingit\\cmd\\git.exe");
  });

  it("reports unavailable when neither executable can run", async () => {
    const executable = await resolveGitExecutable({
      systemCommand: "git",
      bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
      probe: async () => null,
    });

    expect(executable).toBeNull();
  });
});
