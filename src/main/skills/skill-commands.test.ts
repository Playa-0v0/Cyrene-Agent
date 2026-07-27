import { describe, it, expect } from "vitest";
import { parseSlashCommand } from "./skill-commands";

const KNOWN = ["write-expense-report", "code-review"];

describe("parseSlashCommand", () => {
  it("命中已知 /skill-id 返回該 id", () => {
    expect(parseSlashCommand("/write-expense-report", KNOWN)).toEqual({ hit: true, skillId: "write-expense-report" });
  });

  it("命中後帶剩餘文本也識別", () => {
    expect(parseSlashCommand("/write-expense-report 幫我生成本月的", KNOWN)).toEqual({ hit: true, skillId: "write-expense-report" });
  });

  it("未知 /命令（不在已知 skill 列表）放行", () => {
    expect(parseSlashCommand("/help", KNOWN)).toEqual({ hit: false });
    expect(parseSlashCommand("/unknown-skill", KNOWN)).toEqual({ hit: false });
  });

  it("普通文本放行", () => {
    expect(parseSlashCommand("幫我記賬", KNOWN)).toEqual({ hit: false });
  });

  it("非 kebab-case 的 / 前綴放行（防路徑穿越/大寫）", () => {
    expect(parseSlashCommand("/../etc/passwd", KNOWN)).toEqual({ hit: false });
    expect(parseSlashCommand("/Write_Expense", KNOWN)).toEqual({ hit: false });
  });

  it("空格開頭的 / 不命中", () => {
    expect(parseSlashCommand("/ something", KNOWN)).toEqual({ hit: false });
  });

  it("//x 和 /id/extra 不命中（防誤吞）", () => {
    expect(parseSlashCommand("//x", KNOWN)).toEqual({ hit: false });
    expect(parseSlashCommand("/write-expense-report/extra", KNOWN)).toEqual({ hit: false });
  });

  it("空已知列表時任何 /id 都放行", () => {
    expect(parseSlashCommand("/write-expense-report", [])).toEqual({ hit: false });
  });
});
