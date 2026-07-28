import { Jieba } from "@node-rs/jieba";
import type { SocialAtom } from "./types";

const jieba = new Jieba();
const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 30;

function tokenize(text: string): string[] {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return [];
  try {
    return jieba.cut(normalized, true)
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !/^\s+$/.test(token));
  } catch {
    return normalized.match(/[\u4e00-\u9fff]|[a-z0-9]+/g) ?? [];
  }
}

function bm25Scores(query: string, atoms: readonly SocialAtom[]): number[] {
  const queryTokens = [...new Set(tokenize(query))];
  const documents = atoms.map((atom) => tokenize(atom.content));
  if (queryTokens.length === 0 || documents.length === 0) return atoms.map(() => 0);
  const avgLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  return documents.map((tokens) => {
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (frequency === 0) continue;
      const documentCount = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - documentCount + 0.5) / (documentCount + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * tokens.length / avgLength);
      score += idf * frequency * 2.2 / denominator;
    }
    return score;
  });
}

export function rankSocialAtoms(
  query: string,
  atoms: readonly SocialAtom[],
  options: { now?: number; limit?: number } = {},
): SocialAtom[] {
  const now = options.now ?? Date.now();
  const limit = Math.max(0, options.limit ?? 5);
  const active = atoms.filter((atom) => (
    atom.status === "active"
    && (typeof atom.expiresAt !== "number" || atom.expiresAt > now)
  ));
  const lexicalScores = bm25Scores(query, active);
  return active
    .map((atom, index) => {
      const ageDays = Math.max(0, now - atom.createdAt) / DAY_MS;
      const timeDecay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      const openLoopFloor = atom.type === "open_loop" ? 0.05 : 0;
      return { atom, score: Math.max(lexicalScores[index], openLoopFloor) * timeDecay };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ atom }) => atom);
}

