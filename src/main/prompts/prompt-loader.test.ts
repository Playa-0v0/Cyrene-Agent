import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  installRoot: "",
  appPath: "",
  userDataPath: "",
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => runtime.appPath,
    getPath: (name: string) => name === "exe"
      ? path.join(runtime.installRoot, "Cyrene.exe")
      : runtime.userDataPath,
  },
}));

import { loadPromptFile } from "./prompt-loader";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-prompt-loader-"));
runtime.installRoot = root;
runtime.appPath = path.join(root, "resources", "app.asar");
runtime.userDataPath = path.join(root, "user-data");

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadPromptFile in packaged builds", () => {
  it("reads an editable prompt beside Cyrene.exe instead of app.asar", () => {
    const prompts = path.join(root, "prompts");
    fs.mkdirSync(prompts, { recursive: true });
    fs.writeFileSync(path.join(prompts, "soul.md"), "editable soul\n", "utf8");

    expect(loadPromptFile("soul.md")).toBe("editable soul");
  });

  it("falls back to the shipped prompt beside Cyrene.exe", () => {
    const defaults = path.join(root, "prompts");
    fs.mkdirSync(defaults, { recursive: true });
    fs.writeFileSync(path.join(defaults, "chat_system.md"), "default chat", "utf8");

    expect(loadPromptFile("chat_system.md")).toBe("default chat");
  });

  it("prefers a user prompt in userData over the shipped prompt", () => {
    const userPrompts = path.join(root, "user-data", "prompts");
    fs.mkdirSync(userPrompts, { recursive: true });
    fs.writeFileSync(path.join(userPrompts, "soul.md"), "user soul\n", "utf8");

    expect(loadPromptFile("soul.md")).toBe("user soul");
  });
});
