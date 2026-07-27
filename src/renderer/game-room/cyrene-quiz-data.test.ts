import { describe, expect, it } from "vitest";
import { CYRENE_QUIZ_QUESTIONS } from "./cyrene-quiz-data";

describe("Cyrene quiz bank", () => {
  it("contains ten basic and ten spoiler questions", () => {
    expect(CYRENE_QUIZ_QUESTIONS.filter((question) => !question.spoiler)).toHaveLength(10);
    expect(CYRENE_QUIZ_QUESTIONS.filter((question) => question.spoiler)).toHaveLength(10);
  });

  it("has valid answers and unique ids", () => {
    expect(new Set(CYRENE_QUIZ_QUESTIONS.map((question) => question.id)).size).toBe(CYRENE_QUIZ_QUESTIONS.length);
    for (const question of CYRENE_QUIZ_QUESTIONS) {
      expect(question.options).toHaveLength(4);
      expect(question.answer).toBeGreaterThanOrEqual(0);
      expect(question.answer).toBeLessThan(4);
      expect(question.explanation.length).toBeGreaterThan(0);
    }
  });
});
