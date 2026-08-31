import {
  type RuntimeState,
  type RuntimeFeeling,
  feelingToExpression,
  inferRuntimeState,
} from "../runtime-state";
import {
  createFeelingScores,
  smoothFeeling,
  type FeelingScores,
} from "./runtime-state-smoother";

export interface RuntimeStateService {
  getState(): RuntimeState;
  setState(partial: Partial<RuntimeState>): void;
  setStateWithoutNotify(partial: Partial<RuntimeState>): void;
  smoothFeeling(feeling: string): void;
  inferFromText(userText: string, reply: string, toolCalled?: boolean): { status: string };
  onChange(listener: (state: RuntimeState) => void): () => void;
}

export function createRuntimeStateService(): RuntimeStateService {
  let state: RuntimeState = {
    status: "陪伴中",
    feeling: "平静",
    expression: 0,
    updatedAt: Date.now(),
  };
  let feelingScores: FeelingScores = createFeelingScores(state.feeling);
  const listeners = new Set<(state: RuntimeState) => void>();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // ignore observer errors
      }
    }
  };

  return {
    getState: () => state,

    setState: (partial) => {
      state = { ...state, ...partial };
      if (partial.feeling !== undefined) {
        feelingScores = createFeelingScores(partial.feeling);
      }
      notify();
    },

    setStateWithoutNotify: (partial) => {
      state = { ...state, ...partial };
      if (partial.feeling !== undefined) {
        feelingScores = createFeelingScores(partial.feeling);
      }
    },

    smoothFeeling: (feeling) => {
      const smoothed = smoothFeeling(feelingScores, feeling);
      feelingScores = smoothed.scores;
      state = {
        ...state,
        feeling: smoothed.feeling as RuntimeFeeling,
        expression: feelingToExpression[smoothed.feeling] ?? 0,
        updatedAt: Date.now(),
      };
      notify();
    },

    inferFromText: (userText, reply, toolCalled = false) => {
      const inferred = inferRuntimeState(userText, reply, toolCalled);
      state = {
        ...state,
        status: inferred.status,
        expression: feelingToExpression[state.feeling] ?? 0,
        updatedAt: Date.now(),
      };
      return inferred;
    },

    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
