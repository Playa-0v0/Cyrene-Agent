// ASR 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const asrEngineSelect = document.getElementById("asr-engine") as HTMLSelectElement | null;
export const asrAliyunConfig = document.getElementById("asr-aliyun-config");
export const asrAliyunAppKeyInput = document.getElementById("asr-aliyun-app-key") as HTMLInputElement | null;
export const asrAliyunAccessKeyIdInput = document.getElementById("asr-aliyun-access-key-id") as HTMLInputElement | null;
export const asrAliyunAccessKeySecretInput = document.getElementById("asr-aliyun-access-key-secret") as HTMLInputElement | null;
export const asrMosslandConfig = document.getElementById("asr-mossland-config");
export const asrMosslandKeyInput = document.getElementById("asr-mossland-key") as HTMLInputElement | null;
export const asrLanguageSelect = document.getElementById("asr-language") as HTMLSelectElement | null;
export const asrVadSilenceInput = document.getElementById("asr-vad-silence") as HTMLInputElement | null;
export const asrVadThresholdInput = document.getElementById("asr-vad-threshold") as HTMLInputElement | null;
export const asrVadThresholdValue = document.getElementById("asr-vad-threshold-value");
export const asrShowTranscriptCheckbox = document.getElementById("asr-show-transcript") as HTMLInputElement | null;
