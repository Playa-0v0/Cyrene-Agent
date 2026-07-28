export type JsonCandidateMethod = "direct" | "fence" | "scan";

export interface JsonCandidate {
  raw: string;
  value: Record<string, unknown>;
  method: JsonCandidateMethod;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scanBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function extractJsonCandidates(text: string): JsonCandidate[] {
  if (!text?.trim()) return [];
  const rawCandidates: Array<{ raw: string; method: JsonCandidateMethod }> = [
    { raw: text.trim(), method: "direct" },
  ];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fencePattern)) {
    rawCandidates.push({ raw: match[1].trim(), method: "fence" });
  }
  for (const raw of scanBalancedObjects(text)) {
    rawCandidates.push({ raw, method: "scan" });
  }

  const unique = new Map<string, JsonCandidate>();
  for (const candidate of rawCandidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.raw);
    } catch {
      continue;
    }
    if (!isObject(value)) continue;
    const key = canonicalize(value);
    if (!unique.has(key)) unique.set(key, { ...candidate, value });
  }
  return [...unique.values()];
}

