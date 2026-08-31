export type Live2DDisposerKind = "listener" | "subscription" | "resource";

export interface Live2DRendererLifecycleDiagnostics {
  activeDisposers: number;
  listenerCount: number;
  subscriptionCount: number;
  resourceCount: number;
  labels: string[];
}

type Entry = {
  id: number;
  kind: Live2DDisposerKind;
  label: string;
  dispose: () => void;
};

export class Live2DRendererLifecycleTracker {
  private entries = new Map<number, Entry>();
  private nextId = 1;

  track(kind: Live2DDisposerKind, label: string, dispose: () => void): () => void {
    const id = this.nextId++;
    this.entries.set(id, { id, kind, label, dispose });
    return () => this.disposeOne(id);
  }

  disposeAll(): void {
    for (const id of Array.from(this.entries.keys())) {
      this.disposeOne(id);
    }
  }

  getDiagnostics(): Live2DRendererLifecycleDiagnostics {
    const entries = Array.from(this.entries.values());
    return {
      activeDisposers: entries.length,
      listenerCount: entries.filter((entry) => entry.kind === "listener").length,
      subscriptionCount: entries.filter((entry) => entry.kind === "subscription").length,
      resourceCount: entries.filter((entry) => entry.kind === "resource").length,
      labels: entries.map((entry) => entry.label),
    };
  }

  private disposeOne(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.dispose();
  }
}
