export interface EarlyTtsSettingsLike {
  ttsEngine: string
  ttsAutoRead: boolean
  ttsStreaming: boolean
  ttsMinimaxKey: string
  ttsMinimaxVoiceId: string
}

export interface EarlyTtsSegment {
  segment: string
  remainder: string
}

const SENTENCE_END = /[。！？!?；;\n]/

export function canUseMinimaxStreamingEarly(settings: EarlyTtsSettingsLike | null | undefined): boolean {
  return Boolean(
    settings &&
    settings.ttsEngine === "minimax" &&
    settings.ttsAutoRead &&
    settings.ttsStreaming &&
    settings.ttsMinimaxKey.trim() &&
    settings.ttsMinimaxVoiceId.trim(),
  )
}

export function extractEarlyTtsSegment(text: string, minChars = 8): EarlyTtsSegment | null {
  const trimmed = text.trimStart()
  if (!trimmed) return null

  for (let i = 0; i < trimmed.length; i += 1) {
    if (!SENTENCE_END.test(trimmed[i])) continue
    const segment = trimmed.slice(0, i + 1).trim()
    if (Array.from(segment).length < minChars) return null
    const remainder = trimmed.slice(i + 1).trim()
    return { segment, remainder }
  }

  return null
}
