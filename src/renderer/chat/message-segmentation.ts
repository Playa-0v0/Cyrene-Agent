import {
  normalizeSegmentedOutputMode,
  type DefaultChatMode,
  type SegmentedOutputMode,
} from "../../shared/preferences";
import {
  MAX_MESSAGE_SEGMENTS,
  shouldBreakMessageSegmentAfterChar,
  shouldSkipMessageSegmentLeadingChar,
} from "../../shared/message-segmentation";

const SHORT_REPLY_LIMIT = 45;
const COMPACT_MULTI_SENTENCE_LIMIT = 90;
const MIN_SENTENCE_PART_LENGTH = 14;
export const MAX_ASSISTANT_REPLY_BUBBLES = MAX_MESSAGE_SEGMENTS;
const MIN_PART_LENGTH = 35;
const IDEAL_MIN = 55;
const HARD_MAX = 130;
const STRONG_PAUSE = /[。！？!?；;♪～~]/;
const WEAK_PAUSE = /[，,：:]/;

export function shouldSegmentAssistantReply(
  chatMode: DefaultChatMode,
  preference: SegmentedOutputMode,
): boolean {
  const mode = normalizeSegmentedOutputMode(preference);
  return mode === "all" || (mode === "chat" && chatMode === "chat");
}

export function shouldBreakStreamingBubbleAfterChar(char: string): boolean {
  return shouldBreakMessageSegmentAfterChar(char);
}

export function shouldSkipStreamingBubbleLeadingChar(char: string, isAtBubbleStart: boolean): boolean {
  return shouldSkipMessageSegmentLeadingChar(char, isAtBubbleStart);
}

export function segmentAssistantReply(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length < SHORT_REPLY_LIMIT || hasStructuredContent(clean)) return [clean];

  if (clean.length <= COMPACT_MULTI_SENTENCE_LIMIT) {
    const sentenceParts = splitCompactSentences(clean);
    if (sentenceParts.length > 1) return sentenceParts;
  }

  const maxParts = chooseMaxParts(clean.length);
  const targetLength = Math.ceil(clean.length / maxParts);
  const roughParts = splitByNaturalPauses(clean, targetLength, maxParts);
  const merged = mergeTinyParts(roughParts, maxParts);
  return merged.length > 1 ? merged : [clean];
}

export function getAssistantReplyBubbleTexts(
  text: string,
  chatMode: DefaultChatMode,
  preference: SegmentedOutputMode,
  options: { preserveEmpty?: boolean } = {},
): string[] {
  if (!text.trim()) return options.preserveEmpty ? [""] : [];
  return shouldSegmentAssistantReply(chatMode, preference)
    ? segmentAssistantReply(text)
    : [text];
}

function chooseMaxParts(length: number): number {
  if (length <= 220) return 4;
  if (length <= 380) return 6;
  if (length <= 700) return 8;
  return MAX_ASSISTANT_REPLY_BUBBLES;
}

function hasStructuredContent(text: string): boolean {
  if (text.includes("```")) return true;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const listLines = lines.filter((line) => /^([-*+]\s+|\d+[.)]\s+)/.test(line)).length;
  if (listLines >= 2) return true;
  const tableLines = lines.filter((line) => line.startsWith("|") && line.endsWith("|")).length;
  if (tableLines >= 2) return true;
  if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(text) && text.includes("\n")) return true;
  return false;
}

function splitByNaturalPauses(text: string, targetLength: number, maxParts: number): string[] {
  const parts: string[] = [];
  let buffer = "";

  for (const char of text) {
    buffer += char;
    const remainingSlots = maxParts - parts.length - 1;
    if (remainingSlots <= 0) continue;

    const len = buffer.length;
    const canSplitStrong = len >= IDEAL_MIN && STRONG_PAUSE.test(char);
    const canSplitWeak = len >= targetLength && WEAK_PAUSE.test(char);
    const mustSplit = len >= HARD_MAX && (STRONG_PAUSE.test(char) || WEAK_PAUSE.test(char));

    if (canSplitStrong || canSplitWeak || mustSplit) {
      parts.push(buffer);
      buffer = "";
    }
  }

  if (buffer) parts.push(buffer);
  return parts;
}

function splitCompactSentences(text: string): string[] {
  const sentences = splitIntoStrongPauseUnits(text);
  if (sentences.length < 2) return [text];

  const parts: string[] = [];
  for (let i = 0; i < sentences.length; i += 1) {
    let part = sentences[i];
    while (part.length < MIN_SENTENCE_PART_LENGTH && i < sentences.length - 1) {
      i += 1;
      part += sentences[i];
    }
    parts.push(part);
  }

  while (parts.length > MAX_ASSISTANT_REPLY_BUBBLES) {
    const tail = parts.pop();
    if (tail === undefined) break;
    parts[parts.length - 1] += tail;
  }

  return parts.length > 1 ? parts : [text];
}

function splitIntoStrongPauseUnits(text: string): string[] {
  const parts: string[] = [];
  let buffer = "";

  for (const char of text) {
    buffer += char;
    if (STRONG_PAUSE.test(char)) {
      parts.push(buffer);
      buffer = "";
    }
  }

  if (buffer) parts.push(buffer);
  return parts;
}

function mergeTinyParts(parts: string[], maxParts: number): string[] {
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous !== undefined && (part.length < MIN_PART_LENGTH || previous.length < MIN_PART_LENGTH)) {
      merged[merged.length - 1] = previous + part;
    } else {
      merged.push(part);
    }
  }

  while (merged.length > maxParts) {
    const tail = merged.pop();
    if (tail === undefined) break;
    merged[merged.length - 1] += tail;
  }

  return merged;
}
