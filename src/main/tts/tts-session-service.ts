import type { StartTtsRequest, TtsSessionEvent, TtsStartResult } from "../../shared/tts-session";

export interface TtsSessionExecution {
  result: TtsStartResult;
  completion: Promise<void>;
}

type SynthesizeTts = (
  request: StartTtsRequest,
  signal: AbortSignal,
  emit: (event: TtsSessionEvent) => void,
) => Promise<TtsStartResult | TtsSessionExecution>;

/** requestId 只负责会话隔离与取消；远端合成本身不承诺可暂停。 */
export class TtsSessionService {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly synthesize: SynthesizeTts) {}

  async start(request: StartTtsRequest, onEvent: (event: TtsSessionEvent) => void = () => undefined): Promise<TtsStartResult> {
    this.cancel(request.requestId);
    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    let ownsAsyncCompletion = false;
    const emit = (event: TtsSessionEvent) => {
      if (
        !controller.signal.aborted
        && this.active.get(request.requestId) === controller
        && event.requestId === request.requestId
      ) onEvent(event);
    };
    try {
      const execution = await this.synthesize(request, controller.signal, emit);
      const result = "result" in execution ? execution.result : execution;
      if ("result" in execution) {
        ownsAsyncCompletion = true;
        void execution.completion.catch((error) => {
          emit({
            requestId: request.requestId,
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }).finally(() => {
          if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId);
        });
      }
      return controller.signal.aborted
        ? { requestId: request.requestId, status: "cancelled" }
        : result;
    } finally {
      if (!ownsAsyncCompletion && this.active.get(request.requestId) === controller) this.active.delete(request.requestId);
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.active.delete(requestId);
    return true;
  }
}
