const PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  // MUSIC_U=value (delimiter = ; , ) } whitespace)
  { pattern: /\bMUSIC_U=[^;\s,)}]+/g, replace: "MUSIC_U=<redacted>" },
  // MUSIC_U inside JSON dict or quoted: "MUSIC_U":"value" or 'MUSIC_U':'value'
  { pattern: /(["'])MUSIC_U(["'])\s*:\s*["'][^"']*["']/g, replace: "$1MUSIC_U$2:\"<redacted>\"" },
  // __csrf=value ; csrf_token=value (delimiter = ; & whitespace)
  { pattern: /\b__csrf=[^;\s&]+/g, replace: "__csrf=<redacted>" },
  { pattern: /\bcsrf_token=[^&\s;]+/g, replace: "csrf_token=<redacted>" },
  // Inline cookies dict (whole-object redaction)
  { pattern: /(["']?cookies?["']?\s*[:=]\s*)(\{[^}]+\})/g, replace: "$1<redacted>" },
  // Authorization: Bearer <token> (case-insensitive; stop at ; , whitespace ) })
  { pattern: /(\bAuthorization\s*:\s*Bearer\s+)[^\s;,)}]+/gi, replace: "$1<redacted>" },
  // Generic API key fields in logs (apiKey=, api_key:, x-api-key:)
  { pattern: /(["'])(api[_-]?key|x-api-key)\1\s*:\s*["'][^"']*["']/gi, replace: "$1$2$1:\"<redacted>\"" },
  { pattern: /(\b(?:api[_-]?key|x-api-key)\b\s*[:=]\s*)["']?[^"'\s,;)}]+["']?/gi, replace: "$1<redacted>" },
];

export function sanitizeLogLine(line: string): string {
  let out = line;
  for (const { pattern, replace } of PATTERNS) out = out.replace(pattern, replace);
  return out;
}
