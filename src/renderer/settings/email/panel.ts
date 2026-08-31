// Email 面板业务逻辑：配置加载 / 保存 / 字段可见性同步
// 从 settings.ts 抽离。依赖 email DOM 引用（./dom）、pluginsState（../plugins/state，复用防抖 timer）。

import {
  emailEnabledCheckbox, emailConfig,
  emailSmtpHostInput, emailSmtpPortInput, emailSmtpSecureInput,
  emailSmtpUserInput, emailSmtpPassInput, emailFromNameInput,
} from "./dom";
import { pluginsState } from "../plugins/state";

export function syncEmailConfigVisibility(): void {
  if (emailConfig) emailConfig.style.display = emailEnabledCheckbox?.checked ? "block" : "none";
}

export async function saveEmailField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[plugins] 保存邮件配置失败:", field, err);
  }
}

export async function loadEmailConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg && emailEnabledCheckbox) {
      emailEnabledCheckbox.checked = Boolean(cfg.emailEnabled);
    }
    if (cfg && emailSmtpHostInput) {
      emailSmtpHostInput.value = String(cfg.emailSmtpHost ?? "");
    }
    if (cfg && emailSmtpPortInput) {
      emailSmtpPortInput.value = String(cfg.emailSmtpPort ?? 465);
    }
    if (cfg && emailSmtpSecureInput) {
      emailSmtpSecureInput.checked = Boolean(cfg.emailSmtpSecure);
    }
    if (cfg && emailSmtpUserInput) {
      emailSmtpUserInput.value = String(cfg.emailSmtpUser ?? "");
    }
    if (cfg && emailSmtpPassInput) {
      emailSmtpPassInput.value = String(cfg.emailSmtpPass ?? "");
    }
    if (cfg && emailFromNameInput) {
      emailFromNameInput.value = String(cfg.emailFromName ?? "");
    }
    syncEmailConfigVisibility();
  } catch (err) {
    console.warn("[plugins] 加载邮件配置失败", err);
  }
}

// ===== 事件绑定（模块加载时执行） =====
emailEnabledCheckbox?.addEventListener("change", () => {
  syncEmailConfigVisibility();
  void saveEmailField("emailEnabled", emailEnabledCheckbox.checked);
});
// 防抖保存：每个字段独立 timer，避免连续填写多个字段时只有最后一个被保存
emailSmtpHostInput?.addEventListener("input", () => { clearTimeout(pluginsState.emailSmtpHostTimer); pluginsState.emailSmtpHostTimer = setTimeout(() => void saveEmailField("emailSmtpHost", emailSmtpHostInput.value.trim()), 800); });
emailSmtpPortInput?.addEventListener("input", () => { clearTimeout(pluginsState.emailSmtpPortTimer); pluginsState.emailSmtpPortTimer = setTimeout(() => void saveEmailField("emailSmtpPort", Number(emailSmtpPortInput.value) || 465), 800); });
emailSmtpSecureInput?.addEventListener("change", () => void saveEmailField("emailSmtpSecure", emailSmtpSecureInput.checked));
emailSmtpUserInput?.addEventListener("input", () => { clearTimeout(pluginsState.emailSmtpUserTimer); pluginsState.emailSmtpUserTimer = setTimeout(() => void saveEmailField("emailSmtpUser", emailSmtpUserInput.value.trim()), 800); });
emailSmtpPassInput?.addEventListener("input", () => { clearTimeout(pluginsState.emailSmtpPassTimer); pluginsState.emailSmtpPassTimer = setTimeout(() => void saveEmailField("emailSmtpPass", emailSmtpPassInput.value.trim()), 800); });
emailFromNameInput?.addEventListener("input", () => { clearTimeout(pluginsState.emailFromNameTimer); pluginsState.emailFromNameTimer = setTimeout(() => void saveEmailField("emailFromName", emailFromNameInput.value.trim()), 800); });

// 模块加载时拉一次配置
void loadEmailConfig();
