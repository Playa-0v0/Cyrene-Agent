export interface TurnSubmitter {
  request(): boolean;
  reset(): void;
  syncAvailability(): void;
}

interface TurnSubmitterOptions {
  button: HTMLButtonElement;
  isListening: () => boolean;
  sendTurn: () => void;
}

export function createTurnSubmitter(options: TurnSubmitterOptions): TurnSubmitter {
  let pending = false;

  const syncAvailability = (): void => {
    options.button.disabled = pending || !options.isListening();
  };

  const request = (): boolean => {
    if (pending || !options.isListening()) return false;
    pending = true;
    syncAvailability();
    options.sendTurn();
    return true;
  };

  options.button.addEventListener("click", request);

  return {
    request,
    reset: () => {
      pending = false;
      syncAvailability();
    },
    syncAvailability,
  };
}
