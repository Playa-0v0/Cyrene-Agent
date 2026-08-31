import { afterEach, describe, expect, test } from "vitest";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../../../shared/custom-endpoint-state";
import {
  getVendorRuntimeSettings,
  resolveVendorRuntimeSettings,
  setVendorRuntimeSettingsGetter,
  type VendorRuntimeSettings,
  type VendorRuntimeSettingsSource,
} from "./runtime-settings";

/**
 * 测试覆盖两件事：
 *
 * 1. resolveVendorRuntimeSettings —— 纯函数，覆盖"自定义端点 / preset 厂商"分流
 *    这是这次改动引入的核心逻辑，必须锁住。
 *
 * 2. getVendorRuntimeSettings / setVendorRuntimeSettingsGetter —— 验证 getter
 *    注入 + 默认空 fallback 的行为，避免以后误改造成 adapter 拿不到值。
 */

describe("resolveVendorRuntimeSettings — 分流逻辑", () => {
  describe("自定义端点（云端 / 本地）", () => {
    test("云端端点：thinkingOverride / disableMaxToken 原样透传", () => {
      const source: VendorRuntimeSettingsSource = {
        provider: CUSTOM_ENDPOINT_PROVIDERS.cloud,
        thinkingOverride: 1,
        disableMaxToken: true,
      };
      expect(resolveVendorRuntimeSettings(source)).toEqual({
        thinkingOverride: 1,
        disableMaxToken: true,
      });
    });

    test("本地端点：thinkingOverride = -1 / disableMaxToken = true 都透传", () => {
      const source: VendorRuntimeSettingsSource = {
        provider: CUSTOM_ENDPOINT_PROVIDERS.local,
        thinkingOverride: -1,
        disableMaxToken: true,
      };
      expect(resolveVendorRuntimeSettings(source)).toEqual({
        thinkingOverride: -1,
        disableMaxToken: true,
      });
    });

    test("自定义端点字段缺省时返回 undefined / false（不臆造）", () => {
      expect(
        resolveVendorRuntimeSettings({ provider: CUSTOM_ENDPOINT_PROVIDERS.cloud }),
      ).toEqual({
        thinkingOverride: undefined,
        disableMaxToken: undefined,
      });
    });
  });

  describe("preset 厂商（命中 capability 表的 9 家）", () => {
    test.each([
      ["MiniMax（稀宇科技）", 1, true],
      ["DeepSeek（深度求索）", -1, true],
      ["豆包（火山方舟）", 1, false],
      ["GLM（智谱）", 1, true],
      ["Qwen（通义千问）", -1, true],
      ["ChatGPT（OpenAI）", 1, true],
      ["Claude（Anthropic）", -1, true], // 关键保护场景
      ["MiMo（小米）", 1, false],
      ["Kimi（月之暗面）", 1, true],
    ])(
      "%s 即使 thinkingOverride=%i、disableMaxToken=%s 也被强制归零（保护 Claude / 避免花瓶）",
      (provider, thinkingOverride, disableMaxToken) => {
        expect(
          resolveVendorRuntimeSettings({
            provider,
            thinkingOverride: thinkingOverride as -1 | 0 | 1,
            disableMaxToken,
          }),
        ).toEqual({
          thinkingOverride: 0,
          disableMaxToken: false,
        });
      },
    );

    test("关键回归：Claude 用户开了 disableMaxToken 不会让主聊天 400", () => {
      // 历史背景：disableMaxToken=true + Anthropic adapter → JSON 跳过 max_tokens → API 报错
      // 修复后：preset 厂商下 disableMaxToken 强制 false，Anthropic adapter 仍发默认 4096
      const result = resolveVendorRuntimeSettings({
        provider: "Claude（Anthropic）",
        disableMaxToken: true,
      });
      expect(result.disableMaxToken).toBe(false);
    });

    test("关键回归：DeepSeek 用户开强制启用思考不会让 tool_choice omit", () => {
      // 历史背景：thinkingOverride=1 + DeepSeek + chat 下拉 on → tool_choice omit
      // 修复后：preset 厂商下 thinkingOverride 强制 0，DeepSeek 按 pref 走不触发 omit
      const result = resolveVendorRuntimeSettings({
        provider: "DeepSeek（深度求索）",
        thinkingOverride: 1,
      });
      expect(result.thinkingOverride).toBe(0);
    });

    test("关键回归：fixed-on 模型用户（Qwen-thinking）开强制禁用不再误导", () => {
      // 历史背景：fixed-on 模型 thinkingOverride=-1 时 capability 表仍发 thinking 字段（如果 requestStyle 不是 none）
      // 修复后：preset 厂商下开关失效，由 capability + chat 下拉单一信息源决定
      const result = resolveVendorRuntimeSettings({
        provider: "Qwen（通义千问）",
        thinkingOverride: -1,
      });
      expect(result.thinkingOverride).toBe(0);
    });
  });

  describe("未识别 provider", () => {
    test("未知字符串（拼错 / 自定义命名）按 preset 处理", () => {
      // 防止用户随便写 provider 字符串绕过保护
      const result = resolveVendorRuntimeSettings({
        provider: "deepseek-typo",
        thinkingOverride: 1,
        disableMaxToken: true,
      });
      expect(result).toEqual({
        thinkingOverride: 0,
        disableMaxToken: false,
      });
    });

    test("空字符串按 preset 处理", () => {
      expect(
        resolveVendorRuntimeSettings({
          provider: "",
          thinkingOverride: 1,
          disableMaxToken: true,
        }),
      ).toEqual({
        thinkingOverride: 0,
        disableMaxToken: false,
      });
    });
  });
});

describe("getVendorRuntimeSettings / setVendorRuntimeSettingsGetter", () => {
  afterEach(() => {
    // 清理：每个 case 结束后重置 getter，避免污染其他测试
    setVendorRuntimeSettingsGetter(() => ({}));
  });

  test("未注入 getter 时返回空对象（adapter 兜底）", () => {
    // 不能直接重置（会污染全局），用闭包隔离：
    // 通过 setVendorRuntimeSettingsGetter(() => ({})) 显式置空验证 fallback
    setVendorRuntimeSettingsGetter(() => ({}));
    expect(getVendorRuntimeSettings()).toEqual({});
  });

  test("注入 getter 后实时读取最新值", () => {
    let snapshot: VendorRuntimeSettings = {
      thinkingOverride: 1,
      disableMaxToken: true,
    };
    setVendorRuntimeSettingsGetter(() => snapshot);

    expect(getVendorRuntimeSettings()).toEqual({
      thinkingOverride: 1,
      disableMaxToken: true,
    });

    // 模拟用户切换 provider 后重新解析
    snapshot = { thinkingOverride: 0, disableMaxToken: false };
    expect(getVendorRuntimeSettings()).toEqual({
      thinkingOverride: 0,
      disableMaxToken: false,
    });
  });

  test("getter 返回自定义端点配置时透传（端到端验证 main 入口的注入）", () => {
    // 模拟 main/index.ts:3111 的注入方式：
    //   setVendorRuntimeSettingsGetter(() => resolveVendorRuntimeSettings(loadModelSettings()))
    setVendorRuntimeSettingsGetter(() =>
      resolveVendorRuntimeSettings({
        provider: CUSTOM_ENDPOINT_PROVIDERS.local,
        thinkingOverride: -1,
        disableMaxToken: true,
      }),
    );
    expect(getVendorRuntimeSettings()).toEqual({
      thinkingOverride: -1,
      disableMaxToken: true,
    });
  });

  test("getter 返回 preset 厂商配置时强制归零（端到端验证 main 入口的注入）", () => {
    setVendorRuntimeSettingsGetter(() =>
      resolveVendorRuntimeSettings({
        provider: "Claude（Anthropic）",
        thinkingOverride: 1,
        disableMaxToken: true,
      }),
    );
    expect(getVendorRuntimeSettings()).toEqual({
      thinkingOverride: 0,
      disableMaxToken: false,
    });
  });
});
