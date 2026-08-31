// ASR 面板业务逻辑：配置加载 / 保存 / 字段可见性同步
// 从 settings.ts 抽离。依赖 asr DOM 引用（./dom）、asrState（./state）。
// 备注：window.tts 同时承担 ASR 与 TTS 的设置存储（preload 复用同一通道）。

import { asrState } from "./state";
import {
  asrEngineSelect, asrAliyunConfig,
  asrAliyunAppKeyInput, asrAliyunAccessKeyIdInput, asrAliyunAccessKeySecretInput,
  asrMosslandConfig, asrMosslandKeyInput,
  asrLanguageSelect,
  asrVadSilenceInput, asrVadThresholdInput, asrVadThresholdValue,
  asrShowTranscriptCheckbox,
} from "./dom";

export function syncAsrVisibility(): void {
  if (asrAliyunConfig) {
    (asrAliyunConfig as HTMLElement).style.display = asrEngineSelect?.value === "aliyun" ? "block" : "none";
  }
  if (asrMosslandConfig) {
    (asrMosslandConfig as HTMLElement).style.display = asrEngineSelect?.value === "mossland" ? "block" : "none";
  }
}

export async function saveAsrField(field: string, value: unknown): Promise<void> {
  if (!window.tts) return;
  try {
    await window.tts.saveSettings({ [field]: value });
  } catch (err) {
    console.warn("[asr] 保存 ASR 配置失败:", field, err);
  }
}

export async function loadAsrConfig(): Promise<void> {
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg) {
      if (asrEngineSelect) asrEngineSelect.value = String(cfg.asrEngine ?? "off");
      if (asrAliyunAppKeyInput) asrAliyunAppKeyInput.value = String(cfg.asrAliyunAppKey ?? "");
      if (asrAliyunAccessKeyIdInput) asrAliyunAccessKeyIdInput.value = String(cfg.asrAliyunAccessKeyId ?? "");
      if (asrAliyunAccessKeySecretInput) asrAliyunAccessKeySecretInput.value = String(cfg.asrAliyunAccessKeySecret ?? "");
      if (asrMosslandKeyInput) asrMosslandKeyInput.value = String(cfg.ttsMosslandKey ?? "");
      if (asrLanguageSelect) asrLanguageSelect.value = String(cfg.asrLanguage ?? "zh");
      if (asrVadSilenceInput) asrVadSilenceInput.value = String(cfg.asrVadSilenceMs ?? 1000);
      if (asrVadThresholdInput) {
        const v = Number(cfg.asrVadThreshold) || 0.01;
        asrVadThresholdInput.value = String(v);
        if (asrVadThresholdValue) asrVadThresholdValue.textContent = String(v);
      }
      if (asrShowTranscriptCheckbox) asrShowTranscriptCheckbox.checked = Boolean(cfg.asrShowTranscript);
    }
    syncAsrVisibility();
  } catch (err) {
    console.warn("[asr] 加载 ASR 配置失败", err);
  }
}

// ===== 事件绑定（模块加载时执行） =====
asrEngineSelect?.addEventListener("change", () => {
  syncAsrVisibility();
  void saveAsrField("asrEngine", asrEngineSelect.value);
});
// 防抖保存：每个字段独立 timer，避免连续填写多个字段时只有最后一个被保存
asrAliyunAppKeyInput?.addEventListener("input", () => { clearTimeout(asrState.aliyunAppKeyTimer); asrState.aliyunAppKeyTimer = setTimeout(() => void saveAsrField("asrAliyunAppKey", asrAliyunAppKeyInput.value.trim()), 800); });
asrAliyunAccessKeyIdInput?.addEventListener("input", () => { clearTimeout(asrState.aliyunAccessKeyIdTimer); asrState.aliyunAccessKeyIdTimer = setTimeout(() => void saveAsrField("asrAliyunAccessKeyId", asrAliyunAccessKeyIdInput.value.trim()), 800); });
asrAliyunAccessKeySecretInput?.addEventListener("input", () => { clearTimeout(asrState.aliyunAccessKeySecretTimer); asrState.aliyunAccessKeySecretTimer = setTimeout(() => void saveAsrField("asrAliyunAccessKeySecret", asrAliyunAccessKeySecretInput.value.trim()), 800); });
asrMosslandKeyInput?.addEventListener("input", () => { clearTimeout(asrState.mosslandKeyTimer); asrState.mosslandKeyTimer = setTimeout(() => void saveAsrField("ttsMosslandKey", asrMosslandKeyInput.value.trim()), 800); });
asrLanguageSelect?.addEventListener("change", () => void saveAsrField("asrLanguage", asrLanguageSelect.value));
asrVadSilenceInput?.addEventListener("input", () => {
  void saveAsrField("asrVadSilenceMs", Number(asrVadSilenceInput.value) || 1000);
});
asrVadThresholdInput?.addEventListener("input", () => {
  const v = Number(asrVadThresholdInput.value) || 0.01;
  if (asrVadThresholdValue) asrVadThresholdValue.textContent = String(v);
  void saveAsrField("asrVadThreshold", v);
});
asrShowTranscriptCheckbox?.addEventListener("change", () => void saveAsrField("asrShowTranscript", asrShowTranscriptCheckbox.checked));

// 模块加载时拉一次配置
void loadAsrConfig();
