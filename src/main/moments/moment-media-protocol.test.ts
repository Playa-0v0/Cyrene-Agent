import { describe, expect, it } from "vitest";
import * as path from "path";
import { parseMomentMediaUrl, resolveMomentMediaPath } from "./moment-media-protocol";

describe("moment-media protocol", () => {
  it("解析合法 URL", () => {
    expect(parseMomentMediaUrl("moment-media://moment_123_abc/1.png"))
      .toEqual({ postId: "moment_123_abc", file: "1.png" });
    expect(parseMomentMediaUrl("moment-media://moment_1_a/12.jpeg"))
      .toEqual({ postId: "moment_1_a", file: "12.jpeg" });
  });

  it("拒绝路径穿越与非法段", () => {
    expect(parseMomentMediaUrl("moment-media://..%2Fsecret/1.png")).toBeNull();
    expect(parseMomentMediaUrl("moment-media://moment_1_a/..%2F..%2Fapp-settings.json")).toBeNull();
    expect(parseMomentMediaUrl("moment-media://moment_1_a/sub%2F1.png")).toBeNull();
    expect(parseMomentMediaUrl("moment-media://moment_1_a/evil.exe")).toBeNull();
    expect(parseMomentMediaUrl("moment-media:///1.png")).toBeNull();
    expect(parseMomentMediaUrl("https://moment_1_a/1.png")).toBeNull();
  });

  it("resolve 结果必须位于 media 根目录内", () => {
    const root = path.join("C:", "userData", "moments-media");
    const resolved = resolveMomentMediaPath(root, "moment_1_a", "1.png");
    expect(resolved).toBe(path.resolve(root, "moment_1_a", "1.png"));

    expect(resolveMomentMediaPath(root, "../escape", "1.png")).toBeNull();
    expect(resolveMomentMediaPath(root, "moment_1_a", "../1.png")).toBeNull();
    expect(resolveMomentMediaPath(root, "moment_1_a", "1.gif")).toBeNull();
  });
});
