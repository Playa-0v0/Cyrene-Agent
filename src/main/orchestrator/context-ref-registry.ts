import { randomUUID } from "crypto";

interface ContextRefEntry<T = unknown> {
  contextRef: string;
  conversationId: string;
  domain: string;
  kind: string;
  expiresAt: number;
  value: T;
}

interface ContextRefRegistryOptions {
  now?: () => number;
  maxRefsPerConversation?: number;
  createId?: () => string;
}

export class ContextRefRegistry {
  private readonly entries = new Map<string, ContextRefEntry>();
  private readonly now: () => number;
  private readonly maxRefs: number;
  private readonly createId: () => string;

  constructor(options: ContextRefRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRefs = Math.max(1, options.maxRefsPerConversation ?? 600);
    this.createId = options.createId ?? (() => `ctx_${randomUUID()}`);
  }

  issue<T>(input: {
    conversationId: string;
    domain: string;
    kind: string;
    expiresAt: number;
    value: T;
  }): string {
    this.evictExpired(input.conversationId);
    const existing = [...this.entries.values()]
      .filter((entry) => entry.conversationId === input.conversationId);
    while (existing.length >= this.maxRefs) {
      const oldest = existing.shift();
      if (oldest) this.entries.delete(oldest.contextRef);
    }

    let contextRef: string;
    do contextRef = this.createId(); while (this.entries.has(contextRef));
    this.entries.set(contextRef, {
      contextRef,
      conversationId: input.conversationId,
      domain: input.domain,
      kind: input.kind,
      expiresAt: input.expiresAt,
      value: structuredClone(input.value),
    });
    return contextRef;
  }

  resolve<T>(contextRef: string, conversationId: string, expectedKind?: string): T {
    const entry = this.entries.get(contextRef);
    if (!entry) throw new Error("E_CONTEXT_REF_NOT_FOUND");
    if (entry.conversationId !== conversationId) {
      throw new Error("E_CONTEXT_REF_CONVERSATION_MISMATCH");
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(contextRef);
      throw new Error("E_CONTEXT_REF_EXPIRED");
    }
    if (expectedKind && entry.kind !== expectedKind) {
      throw new Error("E_CONTEXT_REF_KIND_MISMATCH");
    }
    return structuredClone(entry.value) as T;
  }

  clear(conversationId?: string): void {
    if (conversationId === undefined) {
      this.entries.clear();
      return;
    }
    for (const [contextRef, entry] of this.entries) {
      if (entry.conversationId === conversationId) this.entries.delete(contextRef);
    }
  }

  private evictExpired(conversationId: string): void {
    const now = this.now();
    for (const [contextRef, entry] of this.entries) {
      if (entry.conversationId === conversationId && now >= entry.expiresAt) {
        this.entries.delete(contextRef);
      }
    }
  }
}
