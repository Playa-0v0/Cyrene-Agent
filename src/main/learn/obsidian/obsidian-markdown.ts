import { createHash } from "crypto";

export interface MarkdownHeading {
  level: number;
  depth: number;
  text: string;
  headingText: string;
  path: string[];
  startOffset: number;
  endOffset: number;
}

export interface SectionLocateError {
  kind: "NOT_FOUND" | "AMBIGUOUS";
  matches?: Array<{ path: string[] }>;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function extractHeadings(content: string): MarkdownHeading[] {
  const lines = content.split("\n");
  const headings: MarkdownHeading[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let offset = 0;

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();

      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, text });
      const path = stack.map((h) => h.text);

      headings.push({
        level,
        depth: level,
        text,
        headingText: text,
        path,
        startOffset: offset,
        endOffset: offset + line.length,
      });
    }
    offset += line.length + 1;
  }

  return headings;
}

function findMatches(
  content: string,
  headingPath: string[],
): MarkdownHeading[] | SectionLocateError {
  const headings = extractHeadings(content);
  const matches = headings.filter(
    (h) =>
      h.path.length === headingPath.length &&
      headingPath.every((part, i) => h.path[i] === part),
  );
  if (matches.length === 0) return { kind: "NOT_FOUND" };
  if (matches.length > 1) {
    return {
      kind: "AMBIGUOUS",
      matches: matches.map((m) => ({ path: m.path })),
    };
  }
  return matches;
}

function sectionEndOffset(
  content: string,
  headings: MarkdownHeading[],
  startIndex: number,
  includeChildren: boolean,
): number {
  const startHeading = headings[startIndex];
  let endOffset = content.length;

  for (let i = startIndex + 1; i < headings.length; i++) {
    if (includeChildren) {
      if (headings[i].level <= startHeading.level) {
        endOffset = headings[i].startOffset;
        break;
      }
    } else {
      endOffset = headings[i].startOffset;
      break;
    }
  }

  return endOffset;
}

export function readSection(
  content: string,
  headingPath: string[],
  includeChildren: boolean,
): string | SectionLocateError {
  const headings = extractHeadings(content);
  const matches = findMatches(content, headingPath);
  if ("kind" in matches) return matches;

  const startHeading = matches[0];
  const startIndex = headings.indexOf(startHeading);
  const endOffset = sectionEndOffset(content, headings, startIndex, includeChildren);

  return content.slice(startHeading.startOffset, endOffset).trimEnd();
}

export function replaceSection(
  content: string,
  headingPath: string[],
  newContent: string,
  includeChildren: boolean,
): string | SectionLocateError {
  const headings = extractHeadings(content);
  const matches = findMatches(content, headingPath);
  if ("kind" in matches) return matches;

  const startHeading = matches[0];
  const startIndex = headings.indexOf(startHeading);
  const endOffset = sectionEndOffset(content, headings, startIndex, includeChildren);

  const before = content.slice(0, startHeading.startOffset);
  const after = content.slice(endOffset);
  return (before + newContent + after).replace(/\n+$/, "\n");
}

export function appendToSection(
  content: string,
  headingPath: string[],
  newContent: string,
): string | SectionLocateError {
  const headings = extractHeadings(content);
  const matches = findMatches(content, headingPath);
  if ("kind" in matches) return matches;

  const startHeading = matches[0];
  const startIndex = headings.indexOf(startHeading);
  const endOffset = sectionEndOffset(content, headings, startIndex, true);

  const before = content.slice(0, endOffset).trimEnd();
  const after = content.slice(endOffset);
  return (before + "\n\n" + newContent + "\n" + after).replace(/\n+$/, "\n");
}
