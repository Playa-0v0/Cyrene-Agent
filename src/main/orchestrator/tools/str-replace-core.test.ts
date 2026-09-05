/**
 * str-replace-core 纯函数测试：
 * 三层匹配（精确 → EOL 归一化 → 空白归一化）、缩进对齐、批量 edits 原子性、失败诊断。
 */

import { describe, expect, it } from "vitest";
import { applyStrReplaceEdits } from "./str-replace-core";

describe("精确匹配（第一层）", () => {
  it("单处精确命中替换", () => {
    const result = applyStrReplaceEdits(
      "const a = 1;\nconst b = 2;\nconst c = 3;",
      [{ old_string: "const b = 2;", new_string: "const b = 42;" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toBe("const a = 1;\nconst b = 42;\nconst c = 3;");
    expect(result.whitespaceNormalized).toBe(false);
    expect(result.appliedEdits).toBe(1);
  });

  it("多行精确命中替换", () => {
    const result = applyStrReplaceEdits(
      "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}",
      [{ old_string: "function foo() {\n  return 1;\n}", new_string: "function foo() {\n  return 42;\n}" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toContain("return 42;");
  });

  it("LF old_string 对 CRLF 文件命中且写回保持 CRLF", () => {
    const result = applyStrReplaceEdits(
      "function init() {\r\n  const flowLog = 1;\r\n  return flowLog;\r\n}\r\n",
      [{ old_string: "  const flowLog = 1;\n  return flowLog;", new_string: "  const loopLog = 1;\n  return loopLog;" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eolNormalized).toBe(true);
    expect(result.newContent).toBe(
      "function init() {\r\n  const loopLog = 1;\r\n  return loopLog;\r\n}\r\n",
    );
  });

  it("多处精确命中报 MULTIPLE_MATCHES 且带位置诊断", () => {
    const result = applyStrReplaceEdits(
      "const x = 1;\nconst y = 2;\nconst x = 1;\nconst z = 3;",
      [{ old_string: "const x = 1;", new_string: "const x = 42;" }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("MULTIPLE_MATCHES");
    expect(result.error).toContain("匹配 2 处");
    expect(result.diagnostic?.kind).toBe("multiple_matches");
    expect(result.diagnostic?.matchCount).toBe(2);
    expect(result.diagnostic?.positions?.[0].line).toBe(1);
    expect(result.diagnostic?.positions?.[1].line).toBe(3);
  });

  it("未命中报 OLD_STRING_NOT_FOUND 且带最近似诊断", () => {
    const result = applyStrReplaceEdits(
      "const foo = 1;\nconst bar = 2;\nconst baz = 3;",
      [{ old_string: "const qux = 999;", new_string: "const qux = 42;" }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("OLD_STRING_NOT_FOUND");
    expect(result.error).toContain("空白/缩进归一化");
    expect(result.diagnostic?.kind).toBe("not_found");
    expect(result.diagnostic?.oldStringLength).toBe(16);
    expect(result.diagnostic?.fileEol).toBe("LF");
  });

  it("old_string 为空报 INVALID_INPUT", () => {
    const result = applyStrReplaceEdits("content", [{ old_string: "", new_string: "x" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("INVALID_INPUT");
  });

  it("edits 空数组报 INVALID_INPUT", () => {
    const result = applyStrReplaceEdits("content", []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(result.error).toContain("edits 不能为空数组");
  });
});

describe("空白归一化匹配（第二层）", () => {
  it("缩进不同命中：替换后 new_string 继承文件真实缩进", () => {
    // 模型给的 old 缩进（6 空格）深于文件（4 空格），精确匹配必失败
    const result = applyStrReplaceEdits(
      "function foo() {\n    return 1;\n}\n",
      [{ old_string: "      return 1;", new_string: "return 42;" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.whitespaceNormalized).toBe(true);
    expect(result.newContent).toBe("function foo() {\n    return 42;\n}\n");
  });

  it("行内多余空白不同命中", () => {
    const result = applyStrReplaceEdits(
      "const  config   = {\n  debug: true,\n};\n",
      [{ old_string: "const config = {", new_string: "const settings = {" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.whitespaceNormalized).toBe(true);
    expect(result.newContent).toContain("const settings = {");
  });

  it("多行缩进不同整体命中且每行缩进对齐", () => {
    const result = applyStrReplaceEdits(
      "list:\n  - alpha\n  - beta\n",
      [{ old_string: "- alpha\n- beta", new_string: "- alpha2\n- beta2" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toBe("list:\n  - alpha2\n  - beta2\n");
  });

  it("缩进比模型浅（模型多给缩进）时同样对齐", () => {
    const result = applyStrReplaceEdits(
      "root:\n- item\n",
      [{ old_string: "  - item", new_string: "  - item-x" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toBe("root:\n- item-x\n");
  });

  it("new_string 的顶格行在归一化路径下统一继承文件缩进", () => {
    const result = applyStrReplaceEdits(
      "section:\n    old line\n",
      [{ old_string: "      old line", new_string: "      old line\n      NOTE: appended" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 归一化路径下模型缩进不可信：所有行按文件缩进对齐
    expect(result.newContent).toBe("section:\n    old line\n    NOTE: appended\n");
  });

  it("空白归一化后多处命中报 MULTIPLE_MATCHES（精确层未命中时）", () => {
    // old 缩进深于文件 → 精确层 0 命中；trim 后两处相同 → 归一化层多处歧义
    const result = applyStrReplaceEdits(
      "if (a) {\n    return 1;\n}\nif (b) {\n    return 1;\n}\n",
      [{ old_string: "      return 1;", new_string: "return 2;" }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("MULTIPLE_MATCHES");
    expect(result.error).toContain("空白归一化");
    expect(result.diagnostic?.matchCount).toBe(2);
  });

  it("CRLF 文件走空白归一化时保持 CRLF 写回", () => {
    const result = applyStrReplaceEdits(
      "function foo() {\r\n    return 1;\r\n}\r\n",
      [{ old_string: "      return 1;", new_string: "return 42;" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.whitespaceNormalized).toBe(true);
    expect(result.newContent).toBe("function foo() {\r\n    return 42;\r\n}\r\n");
  });
});

describe("批量 edits", () => {
  it("顺序应用多个 edit", () => {
    const result = applyStrReplaceEdits(
      "const a = 1;\nconst b = 2;\nconst c = 3;\n",
      [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const c = 3;", new_string: "const c = 30;" },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedEdits).toBe(2);
    expect(result.newContent).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
    expect(result.segments).toHaveLength(2);
  });

  it("后一个 edit 可匹配前一个 edit 的结果（顺序语义）", () => {
    const result = applyStrReplaceEdits(
      "title: Hello\n",
      [
        { old_string: "title: Hello", new_string: "title: Hello World" },
        { old_string: "Hello World", new_string: "Hi World" },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newContent).toBe("title: Hi World\n");
  });

  it("任一 edit 失败则整体失败（调用方据此不落盘）", () => {
    const result = applyStrReplaceEdits(
      "const a = 1;\nconst b = 2;\n",
      [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "const missing = 0;", new_string: "const missing = 1;" },
      ],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("OLD_STRING_NOT_FOUND");
    expect(result.diagnostic?.editIndex).toBe(1);
  });

  it("批量中第二个 edit 匹配多处时报错带 editIndex", () => {
    const result = applyStrReplaceEdits(
      "x = 1\ny = 2\nx = 1\n",
      [
        { old_string: "y = 2", new_string: "y = 20" },
        { old_string: "x = 1", new_string: "x = 42" },
      ],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe("MULTIPLE_MATCHES");
    expect(result.diagnostic?.editIndex).toBe(1);
  });
});
