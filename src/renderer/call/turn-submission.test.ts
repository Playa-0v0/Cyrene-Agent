// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createTurnSubmitter } from "./turn-submission";

describe("createTurnSubmitter", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button type="button" id="mic-wave">
        <span class="call__mic-wave-bar"></span>
        <span class="call__mic-wave-bar"></span>
        <span class="call__mic-wave-bar"></span>
        <span class="call__mic-wave-bar"></span>
      </button>
    `;
  });

  it("submits once when the waveform button is clicked and blocks duplicate clicks until reset", () => {
    const button = document.getElementById("mic-wave") as HTMLButtonElement;
    const sendTurn = vi.fn();
    let listening = true;
    const submitter = createTurnSubmitter({
      button,
      isListening: () => listening,
      sendTurn,
    });

    submitter.syncAvailability();
    expect(button.disabled).toBe(false);

    button.click();
    button.click();

    expect(sendTurn).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);

    submitter.reset();
    button.click();
    expect(sendTurn).toHaveBeenCalledTimes(2);

    listening = false;
    submitter.reset();
    expect(button.disabled).toBe(true);
    button.click();
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it("uses the shipped waveform control as the manual submit button", () => {
    const html = readFileSync("src/renderer/call/index.html", "utf8");
    const page = new DOMParser().parseFromString(html, "text/html");
    const button = page.getElementById("mic-wave") as HTMLButtonElement;
    const sendTurn = vi.fn();

    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("发送本轮语音");
    expect(button.querySelectorAll(".call__mic-wave-bar")).toHaveLength(4);

    createTurnSubmitter({ button, isListening: () => true, sendTurn }).syncAvailability();
    button.click();

    expect(sendTurn).toHaveBeenCalledOnce();
  });
});
