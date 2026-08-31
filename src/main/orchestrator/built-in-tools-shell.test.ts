import { beforeAll, describe, expect, it } from "vitest";
import { toolRegistry } from "./tool-registry";

describe.runIf(process.platform === "win32")("run_shell shell selection", () => {
  beforeAll(async () => {
    await import("./built-in-tools");
  });

  it("publishes cmd and bash as explicit shell choices while keeping cmd as the default", () => {
    const tool = toolRegistry.getById("run_shell");
    expect(tool?.inputSchema.properties.shell).toEqual({
      type: "string",
      enum: ["cmd", "bash"],
      default: "cmd",
      description: expect.any(String),
    });
  });

  it("executes bash syntax with Bash instead of silently passing it to cmd.exe", async () => {
    const tool = toolRegistry.getById("run_shell");
    if (!tool) throw new Error("run_shell was not registered");

    const raw = await tool.execute(
      { shell: "bash", command: "printf 'cyrene-bash-ok'" },
      { permissionMode: "allow_all" } as never,
    );
    const result = JSON.parse(raw) as {
      shell?: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

    expect(result).toMatchObject({
      shell: "bash",
      exitCode: 0,
      stdout: "cyrene-bash-ok",
      stderr: "",
    });
  });
});
