// TTS 面板字段映射表
// 从 settings.ts 抽离的纯常量映射，无运行时依赖。

export const TTS_FIELD_MAP: Record<string, string> = {
  "tts-minimax-key":          "ttsMinimaxKey",
  "tts-minimax-voice":        "ttsMinimaxVoiceId",
  "tts-minimax-model":        "ttsMinimaxModel",
  "tts-gptsovits-url":        "ttsGptsovitsBaseUrl",
  "tts-gptsovits-ref-audio":  "ttsGptsovitsRefAudioPath",
  "tts-gptsovits-prompt-text":"ttsGptsovitsPromptText",
  "tts-gptsovits-timeout":    "ttsGptsovitsTimeoutMs",
  "tts-custom-cloud-url":     "ttsCustomCloudEndpointUrl",
  "tts-custom-cloud-key":     "ttsCustomCloudApiKey",
  "tts-custom-cloud-voice":   "ttsCustomCloudVoiceId",
  "tts-custom-cloud-timeout": "ttsCustomCloudTimeoutMs",
  "tts-mimo-key":             "ttsMimoKey",
  "tts-mimo-voice-audio":     "ttsMimoVoiceAudioPath",
  "tts-mimo-style":           "ttsMimoStylePrompt",
  "tts-mossland-key":         "ttsMosslandKey",
  "tts-mossland-voice":       "ttsMosslandVoiceId",
  "tts-mossland-model":       "ttsMosslandModel",
  "tts-mossland-text":        "ttsMosslandTestText",
  "tts-mossland-format":      "ttsMosslandFormat",
};

// 每个 Provider 自己负责的文本输入框列表（不含 switch/slider/select，复刻子区块也不在此）
export const TTS_PROVIDER_FIELDS: Record<string, string[]> = {
  minimax:        ["tts-minimax-key", "tts-minimax-voice"],
  gptsovits:      ["tts-gptsovits-url", "tts-gptsovits-ref-audio", "tts-gptsovits-prompt-text", "tts-gptsovits-timeout"],
  "custom-cloud": ["tts-custom-cloud-url", "tts-custom-cloud-key", "tts-custom-cloud-voice", "tts-custom-cloud-timeout"],
  mimo:           ["tts-mimo-key", "tts-mimo-voice-audio", "tts-mimo-style"],
  mossland:       ["tts-mossland-key", "tts-mossland-voice", "tts-mossland-model", "tts-mossland-text", "tts-mossland-format"],
};
