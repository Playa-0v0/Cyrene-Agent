import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { QqChannelConfig } from "../../settings-store";
import { isQqEventAllowed, splitQqText } from "./napcat-adapter";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

const config: QqChannelConfig = {
  enabled: true,
  listenMode: "loopback",
  port: 6200,
  allowedPrivateUserIds: ["1000"],
  allowedGroupIds: ["2000"],
  groupRequireMention: true,
  groupReplyStyle: "reply-and-mention",
  groupToolPolicy: "off",
  groupMemoryPolicy: "shared-personal",
};

describe("NapCatAdapter policy helpers", () => {
  it("requires private allowlist and group allowlist plus bot mention", () => {
    expect(isQqEventAllowed({ message_type: "private", user_id: "1000", message: [] }, config, "9000")).toBe(true);
    expect(isQqEventAllowed({ message_type: "private", user_id: "1001", message: [] }, config, "9000")).toBe(false);
    expect(isQqEventAllowed({ message_type: "group", user_id: "1001", group_id: "2000", message: [] }, config, "9000")).toBe(false);
    expect(isQqEventAllowed({
      message_type: "group",
      user_id: "1001",
      group_id: "2000",
      message: [{ type: "at", data: { qq: "9000" } }],
    }, config, "9000")).toBe(true);
  });

  it("splits long Unicode text without breaking surrogate pairs", () => {
    const chunks = splitQqText(`${"昔".repeat(1499)}。${"🌸".repeat(10)}`);
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0])).toHaveLength(1500);
    expect(chunks.join("")).toBe(`${"昔".repeat(1499)}。${"🌸".repeat(10)}`);
  });
});
