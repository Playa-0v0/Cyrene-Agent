// 桌宠气泡 controller：监听 onShowBubble + 显示气泡 + 播 wav + prepare/mouthStart/mouthStop
// 复用 chat/main.ts playTtsBase64 的口型同步思路。荡秋千随 MOUTH_START 自动触发（SpeakingMotionController）。
import { IPC } from "../../shared/ipc-channels";

const BUBBLE_HOLD_MS = 7000;

export class OpenerBubbleController {
  private bubbleEl: HTMLElement | null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioUrl: string | null = null;
  private mouthStopTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bubbleEl: HTMLElement) {
    this.bubbleEl = bubbleEl;
  }

  attach(): () => void {
    if (!window.live2dSpeech) return () => {};
    return window.live2dSpeech.onShowBubble((payload) => this.handle(payload));
  }

  private handle(payload: { text: string; audioBase64: string; format: "wav" | "mp3"; durationMs: number; sceneId: string; itemId: string }): void {
    if (!this.bubbleEl) return;
    this.stopCurrent();

    // 显示气泡文字
    this.bubbleEl.textContent = payload.text;
    this.bubbleEl.hidden = false;
    this.bubbleEl.classList.add("opener-bubble--show");

    // 点击气泡 = 接话
    this.bubbleEl.onclick = () => {
      window.openerBridge?.feedback({ type: "clicked", sceneId: payload.sceneId, itemId: payload.itemId });
    };

    // prepare（停当前 motion + 嘴动 reset）
    window.live2dSpeech?.prepare();

    // 播 wav
    const mime = payload.format === "wav" ? "audio/wav" : "audio/mp3";
    const bytes = Uint8Array.from(atob(payload.audioBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.currentAudio = audio;
    this.currentAudioUrl = url;

    audio.onended = () => {
      this.releaseCurrentAudio(audio, url);
      window.live2dSpeech?.stopMouth();
      this.fadeTimer = setTimeout(() => this.fadeOut(), BUBBLE_HOLD_MS);
    };

    void audio.play().then(() => {
      // 播放开始 → 嘴动 + 荡秋千（startMouth 自动连带 speakingMotion）
      window.live2dSpeech?.startMouth(payload.durationMs);
      this.mouthStopTimer = setTimeout(() => {
        window.live2dSpeech?.stopMouth();
      }, payload.durationMs + 500);
    }).catch((err) => {
      console.warn("[OpenerBubble] 播放失败:", err);
      this.releaseCurrentAudio(audio, url);
      this.fadeOut();
    });
  }

  private fadeOut(): void {
    if (!this.bubbleEl) return;
    this.bubbleEl.classList.remove("opener-bubble--show");
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.bubbleEl) this.bubbleEl.hidden = true;
    }, 300);
  }

  private stopCurrent(): void {
    if (this.currentAudio) {
      this.releaseCurrentAudio(this.currentAudio, this.currentAudioUrl);
    }
    if (this.mouthStopTimer) { clearTimeout(this.mouthStopTimer); this.mouthStopTimer = null; }
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    window.live2dSpeech?.stopMouth();
  }

  dispose(): void {
    this.stopCurrent();
    if (this.bubbleEl) {
      this.bubbleEl.onclick = null;
      this.bubbleEl.hidden = true;
    }
    this.bubbleEl = null;
  }

  private releaseCurrentAudio(audio: HTMLAudioElement, url: string | null): void {
    if (this.currentAudio !== audio) return;
    this.currentAudio = null;
    this.currentAudioUrl = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (url) URL.revokeObjectURL(url);
  }
}
