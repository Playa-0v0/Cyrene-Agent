// ✉️ 郵件發送工具 —— SMTP 直髮，支持附件/抄送/多收件人。
//
// 設計原則：
// - 複用 GeneralSettings 中 SMTP 配置（host/port/secure/user/pass/fromName）
// - 用 nodemailer 發送，每次 execute 新建 transport（不緩存，配置即時生效）
// - 發信前用 requestUserChoice 彈確認卡片（複用現有 ask_user_choice 機制）
// - 配置通過 setEmailConfig 注入 getter（避免 import index.ts 循環依賴）
// - 錯誤以 [錯誤]/[send_email] 字符串返回，不拋異常（流回對話）

import * as fs from "fs";
import * as path from "path";
import nodemailer from "nodemailer";
import { toolRegistry } from "./tool-registry";
import { requestUserChoice, type ChoiceOption } from "../user-choice";

const LOG_PREFIX = "[EmailTools]";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ══════════════════════════════════════════════════════════
// 配置注入
// ══════════════════════════════════════════════════════════

let emailEnabledGetter: (() => boolean) | null = null;
let smtpHostGetter: (() => string) | null = null;
let smtpPortGetter: (() => number) | null = null;
let smtpSecureGetter: (() => boolean) | null = null;
let smtpUserGetter: (() => string) | null = null;
let smtpPassGetter: (() => string) | null = null;
let fromNameGetter: (() => string) | null = null;

/** index.ts 啟動時注入 SMTP 配置獲取器（每次執行實時讀 GeneralSettings）。 */
export function setEmailConfig(
  enabledGetter: () => boolean,
  hostGetter: () => string,
  portGetter: () => number,
  secureGetter: () => boolean,
  userGetter: () => string,
  passGetter: () => string,
  fromNameFn: () => string,
): void {
  emailEnabledGetter = enabledGetter;
  smtpHostGetter = hostGetter;
  smtpPortGetter = portGetter;
  smtpSecureGetter = secureGetter;
  smtpUserGetter = userGetter;
  smtpPassGetter = passGetter;
  fromNameGetter = fromNameFn;
}

// ══════════════════════════════════════════════════════════
// 工具入口
// ══════════════════════════════════════════════════════════

async function executeSendEmail(args: Record<string, unknown>): Promise<string> {
  // 1. 讀配置 + 啟用檢查
  const enabled = emailEnabledGetter?.() ?? false;
  if (!enabled) {
    return "[錯誤] 郵件功能未啟用，請在設置裡開啟";
  }
  const host = smtpHostGetter?.() ?? "";
  const user = smtpUserGetter?.() ?? "";
  const pass = smtpPassGetter?.() ?? "";
  if (!host || !user || !pass) {
    return "[錯誤] SMTP 配置不完整：缺少 主機/用戶名/授權碼";
  }
  const port = smtpPortGetter?.() ?? 465;
  const secure = smtpSecureGetter?.() ?? (port === 465);
  const fromName = fromNameGetter?.() ?? "";

  // 2. 校驗收件人
  const to = (args.to as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  if (to.length === 0) {
    return "[錯誤] 收件人列表為空";
  }
  const invalidTo = to.find(addr => !EMAIL_REGEX.test(addr));
  if (invalidTo) {
    return `[錯誤] 收件人郵箱無效：${invalidTo}`;
  }
  const cc = (args.cc as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  const invalidCc = cc.find(addr => !EMAIL_REGEX.test(addr));
  if (invalidCc) {
    return `[錯誤] 抄送郵箱無效：${invalidCc}`;
  }

  // 3. 正文
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "").trim();
  const html = args.html ? String(args.html) : undefined;
  if (!subject) {
    return "[錯誤] 郵件主題不能為空";
  }
  if (!body && !html) {
    return "[錯誤] 郵件正文不能為空";
  }

  // 4. 【前置校驗】附件存在性
  const attachments = (args.attachments as unknown[] ?? []).map(String).map(s => s.trim()).filter(Boolean);
  for (const p of attachments) {
    if (!fs.existsSync(p)) {
      return `[錯誤] 附件不存在：${p}`;
    }
  }

  // 5. 確認卡片（實現注意點 12.4：摘要只取 body 純文本，不截取 html）
  const bodyPreview = body.length > 100 ? body.slice(0, 100) + "…" : body;
  const attachNames = attachments.length > 0
    ? attachments.map(p => path.basename(p)).join(", ")
    : "（無）";
  const question = [
    "確認發送郵件？",
    `收件人：${to.join(", ")}`,
    cc.length > 0 ? `抄送：${cc.join(", ")}` : null,
    `主題：${subject}`,
    `正文摘要：${bodyPreview}`,
    `附件：${attachNames}`,
  ].filter(Boolean).join("\n");
  const options: ChoiceOption[] = [
    { label: "發送", value: "send" },
    { label: "取消", value: "cancel" },
  ];
  const choice = await requestUserChoice(question, options, "cancel");
  if (choice !== "send") {
    return "[send_email] 用戶取消發送";
  }

  // 6. 發送（實現注意點 12.2：fromName 轉義；12.3：cc 空數組傳 undefined；12.5：每次新建 transport）
  try {
    // 實現注意點 12.5：每次 execute 新建 transport，不緩存模塊級實例
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    // 實現注意點 12.2：fromName 雙引號轉義（RFC 5322）
    const safeName = fromName.replace(/"/g, '\\"');
    const from = fromName ? `"${safeName}" <${user}>` : user;
    // 實現注意點 12.3：cc 為空數組時傳 undefined，避免空 CC 頭
    const ccField = cc.length > 0 ? cc.join(", ") : undefined;
    const info = await transport.sendMail({
      from,
      to: to.join(", "),
      cc: ccField,
      subject,
      text: body,
      html,
      attachments: attachments.map(p => ({ filename: path.basename(p), path: p })),
    });
    console.log(LOG_PREFIX, "已發送：", info.messageId);
    return `[send_email] 已發送：${to.join(", ")} 主題：${subject}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "發送失敗：", msg);
    return `[錯誤] 發送失敗：${msg}`;
  }
}

// ══════════════════════════════════════════════════════════
// 註冊
// ══════════════════════════════════════════════════════════

/** 註冊郵件工具。index.ts startup 調一次。 */
export function registerEmailTools(): void {
  toolRegistry.register({
    id: "send_email",
    name: "發送郵件",
    description:
      "通過 SMTP 發送郵件給指定收件人，支持附件、抄送。\n\n" +
      "何時用：\n" +
      "- 用戶要求發郵件給某人（如「把這份報告發給 xxx@xxx.com」）\n" +
      "- 配合 write_word/excel/pdf 工具，把生成的文件作為附件發送\n" +
      "- 發送正式郵件、週報、通知等\n\n" +
      "不要用於：\n" +
      "- 群發營銷郵件（每次只能發少量收件人）\n" +
      "- 不帶任何正文內容的空郵件\n" +
      "- 未在設置裡配置 SMTP 的情況（會返回配置缺失錯誤提示）\n\n" +
      "參數：to（收件人數組）、subject（主題）、body（純文本正文）、" +
      "html（可選 HTML 正文，提供則覆蓋 body）、cc（可選抄送）、" +
      "attachments（可選附件絕對路徑數組）。",
    enabled: true,
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        to:          { type: "array", items: { type: "string" }, description: "收件人郵箱地址數組" },
        cc:          { type: "array", items: { type: "string" }, description: "抄送（可選）" },
        subject:     { type: "string", description: "郵件主題" },
        body:        { type: "string", description: "郵件正文（純文本）" },
        html:        { type: "string", description: "HTML 正文（可選，提供則覆蓋 body）" },
        attachments: { type: "array", items: { type: "string" }, description: "附件絕對路徑數組（agent 生成文件或本地文件路徑）" },
      },
      required: ["to", "subject", "body"],
    },
    execute: executeSendEmail,
  });

  console.log(LOG_PREFIX, "已註冊：send_email（✉️郵件發送）");
}
