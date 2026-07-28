import { describe, expect, test } from "vitest";
import { normalizeLang, getLanguageDisplayName } from "./language-normalizer";

describe("language-normalizer", () => {
  describe("normalizeLang", () => {
    test("maps common aliases to Shiki ids", () => {
      expect(normalizeLang("ts")).toBe("typescript");
      expect(normalizeLang("typescript")).toBe("typescript");
      expect(normalizeLang("js")).toBe("javascript");
      expect(normalizeLang("javascript")).toBe("javascript");
      expect(normalizeLang("py")).toBe("python");
      expect(normalizeLang("python")).toBe("python");
      expect(normalizeLang("cs")).toBe("csharp");
      expect(normalizeLang("csharp")).toBe("csharp");
      expect(normalizeLang("c#")).toBe("csharp");
      expect(normalizeLang("cpp")).toBe("cpp");
      expect(normalizeLang("c++")).toBe("cpp");
      expect(normalizeLang("ps1")).toBe("powershell");
      expect(normalizeLang("pwsh")).toBe("powershell");
      expect(normalizeLang("powershell")).toBe("powershell");
      expect(normalizeLang("sh")).toBe("bash");
      expect(normalizeLang("shell")).toBe("bash");
      expect(normalizeLang("bash")).toBe("bash");
      expect(normalizeLang("zsh")).toBe("bash");
      expect(normalizeLang("cmd")).toBe("batch");
      expect(normalizeLang("bat")).toBe("batch");
      expect(normalizeLang("batch")).toBe("batch");
    });

    test("passes through Shiki-native ids", () => {
      expect(normalizeLang("java")).toBe("java");
      expect(normalizeLang("c")).toBe("c");
      expect(normalizeLang("json")).toBe("json");
      expect(normalizeLang("html")).toBe("html");
      expect(normalizeLang("css")).toBe("css");
      expect(normalizeLang("sql")).toBe("sql");
    });

    test("normalizes plaintext aliases", () => {
      expect(normalizeLang("plaintext")).toBe("text");
      expect(normalizeLang("plain")).toBe("text");
      expect(normalizeLang("txt")).toBe("text");
      expect(normalizeLang("text")).toBe("text");
    });

    test("falls back to text for unknown languages", () => {
      expect(normalizeLang("rust")).toBe("text");
      expect(normalizeLang("go")).toBe("text");
      expect(normalizeLang("kotlin")).toBe("text");
      expect(normalizeLang("unknown-lang-xyz")).toBe("text");
    });

    test("handles empty/undefined input", () => {
      expect(normalizeLang("")).toBe("text");
      expect(normalizeLang(undefined)).toBe("text");
      expect(normalizeLang("   ")).toBe("text");
    });

    test("is case-insensitive", () => {
      expect(normalizeLang("TS")).toBe("typescript");
      expect(normalizeLang("TypeScript")).toBe("typescript");
      expect(normalizeLang("PYTHON")).toBe("python");
      expect(normalizeLang("Ps1")).toBe("powershell");
    });
  });

  describe("getLanguageDisplayName", () => {
    test("returns display names for known languages", () => {
      expect(getLanguageDisplayName("typescript")).toBe("TypeScript");
      expect(getLanguageDisplayName("javascript")).toBe("JavaScript");
      expect(getLanguageDisplayName("python")).toBe("Python");
      expect(getLanguageDisplayName("cpp")).toBe("C++");
      expect(getLanguageDisplayName("csharp")).toBe("C#");
      expect(getLanguageDisplayName("powershell")).toBe("PowerShell");
      expect(getLanguageDisplayName("bash")).toBe("Bash");
      expect(getLanguageDisplayName("batch")).toBe("CMD / Batch");
      expect(getLanguageDisplayName("json")).toBe("JSON");
      expect(getLanguageDisplayName("text")).toBe("代码");
    });

    test("returns 代码 for unknown language", () => {
      expect(getLanguageDisplayName("rust")).toBe("代码");
      expect(getLanguageDisplayName("unknown")).toBe("代码");
    });
  });
});
