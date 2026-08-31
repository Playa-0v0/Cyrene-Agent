// Email 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const emailEnabledCheckbox = document.getElementById("plugin-email-enabled") as HTMLInputElement | null;
export const emailConfig = document.getElementById("plugin-email-config") as HTMLElement | null;
export const emailSmtpHostInput = document.getElementById("email-smtp-host") as HTMLInputElement | null;
export const emailSmtpPortInput = document.getElementById("email-smtp-port") as HTMLInputElement | null;
export const emailSmtpSecureInput = document.getElementById("email-smtp-secure") as HTMLInputElement | null;
export const emailSmtpUserInput = document.getElementById("email-smtp-user") as HTMLInputElement | null;
export const emailSmtpPassInput = document.getElementById("email-smtp-pass") as HTMLInputElement | null;
export const emailFromNameInput = document.getElementById("email-from-name") as HTMLInputElement | null;
