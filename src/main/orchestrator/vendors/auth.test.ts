import { describe, expect, test } from "vitest";
import { authHeaderFor } from "./auth";
import type { ProviderCapability } from "./types";

const baseCap: ProviderCapability = {
  id: "test",
  displayName: "Test Provider",
  transport: "openai",
  baseUrl: "https://e.test/v1",
  authStyle: "bearer",
  defaultModel: "m",
  supportsTools: true,
  supportsThinking: false,
  thinkingField: null,
  cacheStrategy: "none",
  testStrategy: "text",
  supportsVision: false,
};

describe("authHeaderFor", () => {
  test("authStyle=bearer → Authorization Bearer", () => {
    const h = authHeaderFor({ ...baseCap, authStyle: "bearer" }, "sk-test");
    expect(h).toEqual({ Authorization: "Bearer sk-test" });
  });

  test("authStyle=x-api-key → x-api-key", () => {
    const h = authHeaderFor({ ...baseCap, authStyle: "x-api-key" }, "sk-test");
    expect(h).toEqual({ "x-api-key": "sk-test" });
  });

  test("Anthropic transport can override the provider default auth style", () => {
    const cap = { ...baseCap, authStyle: "bearer" as const, anthropicAuthStyle: "x-api-key" as const };
    expect(authHeaderFor(cap, "sk-test", "openai")).toEqual({ Authorization: "Bearer sk-test" });
    expect(authHeaderFor(cap, "sk-test", "anthropic")).toEqual({ "x-api-key": "sk-test" });
  });

  test("输出对象不暴露 apiKey 之外的敏感字符串", () => {
    const h = authHeaderFor({ ...baseCap, authStyle: "bearer" }, "sk-very-secret-123");
    // 输出序列化后必须只包含 apiKey 本身，不含其他秘密字段
    const s = JSON.stringify(h);
    expect(s).toContain("sk-very-secret-123");
    expect(s).not.toContain("password");
    expect(s).not.toContain("token=");
  });

  test("非法 authStyle 抛错（包含 displayName，不包含 apiKey）", () => {
    expect(() =>
      authHeaderFor({ ...baseCap, displayName: "MiMo（小米）", authStyle: undefined as unknown as "bearer" }, "sk-very-secret"),
    ).toThrow(/MiMo（小米）/);
    expect(() =>
      authHeaderFor({ ...baseCap, authStyle: "weird" as unknown as "bearer" }, "sk-very-secret"),
    ).toThrow(/invalid authStyle/);
    // 抛错信息不应包含 apiKey 字面量
    try {
      authHeaderFor({ ...baseCap, authStyle: undefined as unknown as "bearer" }, "sk-very-secret");
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-very-secret");
    }
  });
});
