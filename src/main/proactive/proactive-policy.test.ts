import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_INTERVAL_MS,
  GLOBAL_PROACTIVE_INTERVAL_MS,
  NORMAL_QUIET_MS,
  canCommitProactiveMessage,
  canStartProactiveGeneration,
  createDefaultProactiveState,
  markNormalConversationEnded,
  markProactiveCommitted,
  markUserActivity,
} from "./proactive-policy";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

const NOW = Date.UTC(2026, 6, 13, 6, 0, 0);

function snapshot(patch: Partial<ProactiveRuntimeSnapshot> = {}): ProactiveRuntimeSnapshot {
  return {
    now: NOW,
    localHour: 14,
    idleSec: 0,
    enabled: true,
    conversationBusy: false,
    generationBusy: false,
    screenLocked: false,
    ...patch,
  };
}

function candidate(patch: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    sceneId: "work_break",
    score: 90,
    sceneCooldownMs: 2 * 60 * 60 * 1000,
    ...patch,
  };
}

describe("proactive hard policy", () => {
  it("enforces normal quiet period and global proactive interval", () => {
    const state = createDefaultProactiveState();
    state.lastNormalConversationEndedAt = NOW - NORMAL_QUIET_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("normal_quiet_period");

    state.lastNormalConversationEndedAt = NOW - NORMAL_QUIET_MS;
    state.lastProactiveAt = NOW - GLOBAL_PROACTIVE_INTERVAL_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("global_cooldown");

    state.lastProactiveAt = NOW - GLOBAL_PROACTIVE_INTERVAL_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).allowed).toBe(true);
  });

  it("blocks inactive nights but allows a recently active night", () => {
    const state = createDefaultProactiveState();
    expect(canStartProactiveGeneration(snapshot({ localHour: 23, idleSec: 60 }), state, candidate()).reason)
      .toBe("night_inactive");
    expect(canStartProactiveGeneration(snapshot({ localHour: 7, idleSec: 59 }), state, candidate()).allowed)
      .toBe(true);
  });

  it("blocks disabled, locked, busy, and overlapping generation states", () => {
    const state = createDefaultProactiveState();
    expect(canStartProactiveGeneration(snapshot({ enabled: false }), state, candidate()).reason).toBe("disabled");
    expect(canStartProactiveGeneration(snapshot({ screenLocked: true }), state, candidate()).reason).toBe("screen_locked");
    expect(canStartProactiveGeneration(snapshot({ conversationBusy: true }), state, candidate()).reason).toBe("conversation_busy");
    expect(canStartProactiveGeneration(snapshot({ generationBusy: true }), state, candidate()).reason).toBe("generation_busy");
  });

  it("requires six hours, a new scene, and a stricter score for the second message", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 1;
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS + 1;
    state.lastProactiveScene = "work_break";

    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("followup_cooldown");
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("followup_same_scene");
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ sceneId: "rainy_day", score: 84 })).reason)
      .toBe("followup_score_too_low");
    expect(canStartProactiveGeneration(snapshot(), state, candidate({ sceneId: "rainy_day", score: 85 })).allowed)
      .toBe(true);
  });

  it("hard-blocks a third unanswered proactive message", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 2;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("unanswered_limit");
  });

  it("enforces scene cooldown independently from desire", () => {
    const state = createDefaultProactiveState();
    state.globalDesire = 100;
    state.lastFiredAt.work_break = NOW - candidate().sceneCooldownMs + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("scene_cooldown");
  });

  it("rejects a stale generation epoch at commit time", () => {
    const state = createDefaultProactiveState();
    state.proactiveEpoch = 4;
    expect(canCommitProactiveMessage(snapshot(), state, candidate(), 3).reason).toBe("stale_epoch");
    expect(canCommitProactiveMessage(snapshot(), state, candidate(), 4).allowed).toBe(true);
  });

  it("user activity invalidates generation and resets only anti-harassment state", () => {
    const state = createDefaultProactiveState();
    state.proactiveEpoch = 2;
    state.unansweredCount = 1;
    state.affinity.rainy_day = 1.4;

    markUserActivity(state);

    expect(state.proactiveEpoch).toBe(3);
    expect(state.unansweredCount).toBe(0);
    expect(state.affinity.rainy_day).toBe(1.4);
  });

  it("normal conversation end resets desire and starts quiet period", () => {
    const state = createDefaultProactiveState();
    state.globalDesire = 88;
    markNormalConversationEnded(state, NOW);
    expect(state.globalDesire).toBe(0);
    expect(state.lastNormalConversationEndedAt).toBe(NOW);
    expect(state.proactiveEpoch).toBe(1);
  });

  it("committing records scene and increments unanswered count", () => {
    const state = createDefaultProactiveState();
    markProactiveCommitted(state, candidate(), NOW);
    expect(state.unansweredCount).toBe(1);
    expect(state.lastProactiveAt).toBe(NOW);
    expect(state.lastProactiveScene).toBe("work_break");
    expect(state.lastFiredAt.work_break).toBe(NOW);
  });
});
