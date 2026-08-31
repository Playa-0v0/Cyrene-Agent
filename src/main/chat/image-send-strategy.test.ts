import { describe, expect, test } from "vitest";
import { decideImageSendStrategy } from "./image-send-strategy";

describe("decideImageSendStrategy", () => {
  test("uses direct image sending when multimodal is enabled", () => {
    const strategy = decideImageSendStrategy({
      multimodal: true,
    });

    expect(strategy).toEqual({ mode: "direct" });
  });

  test("uses caption when multimodal is disabled", () => {
    const strategy = decideImageSendStrategy({
      multimodal: false,
      vision: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
        apiKey: "key",
      },
    });

    expect(strategy).toEqual({ mode: "caption" });
  });

  test("uses caption when multimodal is disabled and no vision configured", () => {
    const strategy = decideImageSendStrategy({
      multimodal: false,
      vision: null,
    });

    expect(strategy).toEqual({ mode: "caption" });
  });
});
