export interface CodeGitRefreshController {
  request(): void;
  dispose(): void;
}

export function createCodeGitRefreshController<T>(input: {
  load(): Promise<T>;
  apply(value: T): void;
  failed(): void;
  busy(value: boolean): void;
}): CodeGitRefreshController {
  let loading = false;
  let pending = false;
  let disposed = false;

  const run = () => {
    if (disposed || loading) return;
    loading = true;
    input.busy(true);
    void input.load()
      .then((value) => { if (!disposed) input.apply(value); })
      .catch(() => { if (!disposed) input.failed(); })
      .finally(() => {
        loading = false;
        if (!disposed) input.busy(false);
        if (pending && !disposed) {
          pending = false;
          run();
        }
      });
  };

  return {
    request() {
      if (loading) {
        pending = true;
        return;
      }
      run();
    },
    dispose() {
      disposed = true;
      pending = false;
    },
  };
}
