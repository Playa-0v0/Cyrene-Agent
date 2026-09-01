import { describe, expect, it } from "vitest";
import { buildSanitizedPluginEnvironment, PluginSubprocessHost } from "./plugin-subprocess-service";

describe("plugin subprocess service", () => {
  it("inherits only a small safe environment and never inherits credential-shaped values", () => {
    const env = buildSanitizedPluginEnvironment({
      PATH: "C:\\bin",
      SYSTEMROOT: "C:\\Windows",
      OPENAI_API_KEY: "secret",
      RANDOM_VALUE: "hidden",
    }, { PLUGIN_MODE: "test" });
    expect(env).toEqual({ PATH: "C:\\bin", SYSTEMROOT: "C:\\Windows", PLUGIN_MODE: "test" });
  });

  it("starts without a shell, preserves early lines, writes lines, and exits cleanly", async () => {
    const host = new PluginSubprocessHost();
    const controller = new AbortController();
    const service = host.forPlugin("demo", controller.signal);
    const child = await service.spawn({
      executable: process.execPath,
      args: ["-e", "console.log('ready'); process.stdin.once('data', d => { console.log(String(d).trim()); process.exit(0); })"],
    });
    const lines: string[] = [];
    child.onStdoutLine((line) => lines.push(line));
    child.write("ping");
    await child.wait();
    expect(lines).toEqual(["ready", "ping"]);
  });

  it("rejects relative executable paths", async () => {
    const host = new PluginSubprocessHost();
    await expect(host.forPlugin("demo", new AbortController().signal).spawn({ executable: "node" }))
      .rejects.toThrow(/绝对路径/);
  });
});
