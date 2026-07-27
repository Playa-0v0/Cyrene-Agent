import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted 保證 mock 變量在 vi.mock 工廠裡可用（vi.mock 會被提升到文件頂部）
const { sendMailMock, createTransportMock, requestUserChoiceMock, existsSyncMock } = vi.hoisted(() => ({
  sendMailMock: vi.fn(),
  createTransportMock: vi.fn(() => ({ sendMail: sendMailMock })),
  requestUserChoiceMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
}));

// mock nodemailer
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

// mock requestUserChoice —— 默認返回 "send"
vi.mock("../user-choice", () => ({
  requestUserChoice: (...a: unknown[]) => requestUserChoiceMock(...a),
}));

// mock fs.existsSync —— 默認 true（附件存在）
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, existsSync: existsSyncMock };
});

import { setEmailConfig, registerEmailTools } from "./email-tools";
import { toolRegistry } from "./tool-registry";

// 注入測試配置
function injectConfig(overrides: Record<string, unknown> = {}): void {
  const cfg = {
    enabled: true,
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user: "sender@qq.com",
    pass: "authcode123",
    fromName: "昔漣",
    ...overrides,
  };
  setEmailConfig(
    () => cfg.enabled as boolean,
    () => cfg.host as string,
    () => cfg.port as number,
    () => cfg.secure as boolean,
    () => cfg.user as string,
    () => cfg.pass as string,
    () => cfg.fromName as string,
  );
}

// 註冊工具拿到 execute
registerEmailTools();
const tool = toolRegistry.getById("send_email")!;
const exec = tool.execute;

describe("send_email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestUserChoiceMock.mockResolvedValue("send");
    sendMailMock.mockResolvedValue({ messageId: "<test@localhost>" });
    existsSyncMock.mockReturnValue(true);
    injectConfig();
  });

  it("功能未啟用 → 返回錯誤", async () => {
    injectConfig({ enabled: false });
    const res = await exec({ to: ["a@b.com"], subject: "標題", body: "正文" });
    expect(res).toBe("[錯誤] 郵件功能未啟用，請在設置裡開啟");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("SMTP 配置不完整 → 返回錯誤", async () => {
    injectConfig({ host: "" });
    const res = await exec({ to: ["a@b.com"], subject: "標題", body: "正文" });
    expect(res).toBe("[錯誤] SMTP 配置不完整：缺少 主機/用戶名/授權碼");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("收件人郵箱格式無效 → 返回錯誤", async () => {
    const res = await exec({ to: ["not-an-email"], subject: "標題", body: "正文" });
    expect(res).toBe("[錯誤] 收件人郵箱無效：not-an-email");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("附件不存在 → 返回錯誤（前置校驗，不進確認）", async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await exec({
      to: ["a@b.com"],
      subject: "標題",
      body: "正文",
      attachments: ["C:/nope.txt"],
    });
    expect(res).toBe("[錯誤] 附件不存在：C:/nope.txt");
    expect(requestUserChoiceMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("用戶取消 → 返回取消，不調用 sendMail", async () => {
    requestUserChoiceMock.mockResolvedValue("cancel");
    const res = await exec({ to: ["a@b.com"], subject: "標題", body: "正文" });
    expect(res).toBe("[send_email] 用戶取消發送");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("用戶確認 → 調 sendMail，參數正確（from 含 fromName 轉義、cc undefined、attachments 映射）", async () => {
    const res = await exec({
      to: ["a@b.com", "c@d.com"],
      subject: "週報",
      body: "本週內容",
      attachments: ["C:/report.docx"],
    });
    expect(res).toBe("[send_email] 已發送：a@b.com, c@d.com 主題：週報");
    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      auth: { user: "sender@qq.com", pass: "authcode123" },
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('"昔漣" <sender@qq.com>');
    expect(mailOpts.to).toBe("a@b.com, c@d.com");
    expect(mailOpts.cc).toBeUndefined();
    expect(mailOpts.subject).toBe("週報");
    expect(mailOpts.text).toBe("本週內容");
    expect(mailOpts.attachments).toEqual([{ filename: "report.docx", path: "C:/report.docx" }]);
  });

  it("fromName 含雙引號 → 轉義後傳入 from", async () => {
    injectConfig({ fromName: '她說"你好"' });
    await exec({ to: ["a@b.com"], subject: "標題", body: "正文" });
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.from).toBe('"她說\\"你好\\"" <sender@qq.com>');
  });

  it("cc 非空 → 傳入 join 後的 cc", async () => {
    await exec({ to: ["a@b.com"], cc: ["x@y.com", "z@w.com"], subject: "標題", body: "正文" });
    const mailOpts = sendMailMock.mock.calls[0][0];
    expect(mailOpts.cc).toBe("x@y.com, z@w.com");
  });

  it("sendMail 拋錯 → 捕獲返回錯誤字符串", async () => {
    sendMailMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await exec({ to: ["a@b.com"], subject: "標題", body: "正文" });
    expect(res).toBe("[錯誤] 發送失敗：connect ECONNREFUSED");
  });
});
