const PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /\bMUSIC_U=[^;\s]+/g, replace: "MUSIC_U=<redacted>" },
  { pattern: /\b__csrf=[^;\s]+/g, replace: "__csrf=<redacted>" },
  { pattern: /\bcsrf_token=[^&\s]+/g, replace: "csrf_token=<redacted>" },
  { pattern: /(?:^|[\s,{:])MUSIC_U["']?\s*[:=]\s*["']?[^"',;\s}]+/g, replace: "MUSIC_U=<redacted>" },
  { pattern: /(["']?cookies?["']?\s*[:=]\s*)(\{[^}]+\})/g, replace: "$1<redacted>" },
  { pattern: /\bAuthorization:\s*Bearer\s+\S+/g, replace: "Authorization: Bearer <redacted>" },
];

export function sanitizeLogLine(line: string): string {
  let out = line;
  for (const { pattern, replace } of PATTERNS) out = out.replace(pattern, replace);
  return out;
}
