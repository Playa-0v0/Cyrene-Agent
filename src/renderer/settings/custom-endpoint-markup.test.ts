import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
const source = fs.readFileSync(fileURLToPath(new URL("./settings.ts", import.meta.url)), "utf8");
const mcpSource = fs.readFileSync(fileURLToPath(new URL("./mcp/panel.ts", import.meta.url)), "utf8");
const presetsSource = fs.readFileSync(fileURLToPath(new URL("./api/presets.ts", import.meta.url)), "utf8");
const styles = fs.readFileSync(fileURLToPath(new URL("./settings.css", import.meta.url)), "utf8");
const icon = fs.readFileSync(
  fileURLToPath(new URL("../public/icons/providers/custom-endpoint.svg", import.meta.url)),
  "utf8",
);

describe("custom endpoint API settings UI", () => {
  it("contains cloud/local controls and a guide trigger", () => {
    expect(html).toContain('id="custom-endpoint-controls"');
    expect(html).toContain('data-custom-endpoint-mode="cloud"');
    expect(html).toContain('data-custom-endpoint-mode="local"');
    expect(html).toContain('id="custom-endpoint-guide-btn"');
  });

  it("exposes dynamic API field labels and hints", () => {
    const transportSelect = html.match(/id="transport-select"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(html).toContain('id="api-key-label"');
    expect(html).toContain('id="api-key-hint"');
    expect(html).toContain('id="transport-hint"');
    expect(html).toContain('id="endpoint-preview"');
    expect(transportSelect).not.toContain('value="auto"');
  });

  it("ships a local custom endpoint icon", () => {
    expect(icon).toContain("<svg");
    expect(icon).toContain("<title>自定义端点</title>");
  });

  it("includes the support boundary and all requested FAQ topics", () => {
    expect(mcpSource).toContain("本地模型与自定义端点不在官方技术支持范围内");
    expect(mcpSource).toContain("本地模型回复格式异常");
    expect(mcpSource).toContain("MiniMax 思考模式失效");
    expect(mcpSource).toContain("Claude 配置项比其他厂商少");
  });

  it("persists profiles through the model catalog instead of perProvider cache", () => {
    // 档案化改造后：表单绑定档案（editingProfileId），保存走 saveModelProfile；
    // perProvider 缓存体系（providerProfileCache / captureActiveProviderProfile）已退役。
    expect(source).toContain("id: apiState.editingProfileId");
    expect(source).toContain("saveModelProfile?.(profile)");
    expect(source).not.toContain("providerProfileCache");
    expect(source).not.toContain("captureActiveProviderProfile");
  });

  it("reads the custom endpoint button mode directly from its dataset", () => {
    expect(source).toContain("button.dataset.customEndpointMode === mode");
    expect(source).not.toContain("button.dataset.apiState.customEndpointMode");
  });

  it("keeps confirmed Anthropic-compatible preset URLs explicit", () => {
    expect(presetsSource).toContain('anthropicBaseUrl: "https://api.minimaxi.com/anthropic"');
    expect(presetsSource).toContain('anthropicBaseUrl: "https://api.deepseek.com/anthropic"');
    expect(presetsSource).toContain('anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic"');
    expect(presetsSource).toContain('anthropicBaseUrl: "https://api.xiaomimimo.com/anthropic"');
    expect(source).toContain("该厂商的 Anthropic 兼容地址未内置");
  });

  it("top-aligns fields with different amounts of helper text", () => {
    expect(styles).toMatch(/\.field\s*\{[^}]*align-content:\s*start;/s);
  });
});
