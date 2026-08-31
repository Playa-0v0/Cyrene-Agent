import type { MusicSelectionSet } from "./types";

const TTL_MS = 30 * 60_000;
const MAX_TRACKS_PER_SET = 30;
const MAX_SETS_PER_CONVERSATION = 20;

export class SelectionSetCache {
  private bySetId = new Map<string, MusicSelectionSet>();
  private byConversation = new Map<string, Set<string>>();

  add(set: MusicSelectionSet): void {
    if (set.tracks.length > MAX_TRACKS_PER_SET) {
      throw new Error(`MusicSelectionSet has too many tracks (${set.tracks.length} > ${MAX_TRACKS_PER_SET})`);
    }
    this.evictExpired();
    const convSets = this.byConversation.get(set.conversationId) ?? new Set<string>();
    if (convSets.has(set.setId)) {
      this.bySetId.delete(set.setId);
    } else {
      while (convSets.size >= MAX_SETS_PER_CONVERSATION) {
        const oldest = convSets.values().next().value;
        if (!oldest) break;
        convSets.delete(oldest);
        this.bySetId.delete(oldest);
      }
    }
    convSets.add(set.setId);
    this.byConversation.set(set.conversationId, convSets);
    this.bySetId.set(set.setId, set);
  }

  get(setId: string, conversationId: string): MusicSelectionSet | null {
    const s = this.bySetId.get(setId);
    if (!s) return null;
    if (s.conversationId !== conversationId) return null;
    if (Date.now() >= s.expiresAt) {
      this.bySetId.delete(setId);
      this.byConversation.get(conversationId)?.delete(setId);
      return null;
    }
    return s;
  }

  latest(
    conversationId: string,
    source?: MusicSelectionSet["source"],
  ): MusicSelectionSet | null {
    this.evictExpired();
    const ids = [...(this.byConversation.get(conversationId) ?? [])].reverse();
    for (const id of ids) {
      const set = this.bySetId.get(id);
      if (set && (!source || set.source === source)) return set;
    }
    return null;
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.bySetId) {
      if (now >= s.expiresAt) {
        this.bySetId.delete(id);
        this.byConversation.get(s.conversationId)?.delete(id);
      }
    }
  }

  clear(): void {
    this.bySetId.clear();
    this.byConversation.clear();
  }
}
