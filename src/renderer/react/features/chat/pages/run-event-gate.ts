export class RunEventGate<TEvent extends { runId?: string }> {
  private runId: string | undefined;
  private pending: TEvent[] = [];

  accept(event: TEvent): TEvent[] {
    if (!this.runId) {
      this.pending.push(event);
      return [];
    }
    return event.runId === this.runId ? [event] : [];
  }

  bind(runId: string): TEvent[] {
    this.runId = runId;
    const accepted = this.pending.filter((event) => event.runId === runId);
    this.pending = [];
    return accepted;
  }
}
