// read_image_url 测试：URL 校验 + 视觉配置门控 + URL 直传协议（不下载、不 base64）。
// captionImage 与 loadVisionConfig 全部 mock，不发真实请求。

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../settings/model-settings", () => ({
  loadVisionConfig: vi.fn(),
}));

vi.mock("../vision-captioner", () => ({
  captionImage: vi.fn(),
}));

import { readImageUrlTool } from "./builtin-tools/read-image-url-tool";
import { captionImage } from "../vision-captioner";
import { loadVisionConfig } from "../../settings/model-settings";
import type { ToolContext } from "./registry/tool-context";

const mockedCaption = vi.mocked(captionImage);
const mockedLoadConfig = vi.mocked(loadVisionConfig);

const FAKE_CONFIG = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "gpt-4o" };
const CTX: ToolContext = { userQuery: "这图里是什么" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read_image_url 拒绝路径", () => {
  it("非 http(s) 协议拒绝", async () => {
    await expect(readImageUrlTool.execute({ url: "ftp://example.com/a.png" }, CTX))
      .resolves.toBe("[错误] url 必须以 http:// 或 https:// 开头");
    expect(mockedCaption).not.toHaveBeenCalled();
  });

  it("未配置视觉模型返回配置错误", async () => {
    mockedLoadConfig.mockReturnValue(null);
    const result = await readImageUrlTool.execute({ url: "https://example.com/a.png" }, CTX);
    expect(result).toContain("[错误·配置] 未启用视觉能力");
    expect(mockedCaption).not.toHaveBeenCalled();
  });
});

describe("read_image_url URL 直传", () => {
  it("以 { url } 形式调 captionImage，不走 base64", async () => {
    mockedLoadConfig.mockReturnValue(FAKE_CONFIG);
    mockedCaption.mockResolvedValue("一只橘猫趴在键盘上");

    const result = await readImageUrlTool.execute(
      { url: "https://example.com/cat.png" },
      CTX,
    );

    expect(result).toBe("一只橘猫趴在键盘上");
    expect(mockedCaption).toHaveBeenCalledTimes(1);
    const [image, query, config] = mockedCaption.mock.calls[0];
    expect(image).toEqual({ url: "https://example.com/cat.png" });
    expect(image).not.toHaveProperty("base64");
    expect(query).toBe("这图里是什么");
    expect(config).toEqual(FAKE_CONFIG);
  });

  it("无 ToolContext 时 userQuery 回退空串", async () => {
    mockedLoadConfig.mockReturnValue(FAKE_CONFIG);
    mockedCaption.mockResolvedValue("描述");

    await readImageUrlTool.execute({ url: "https://example.com/a.jpg" });

    expect(mockedCaption.mock.calls[0][1]).toBe("");
  });
});
