// 桌寵氣泡 controller：監聽 onShowBubble + 顯示氣泡 + 播 wav + prepare/mouthStart/mouthStop
// 複用 chat/main.ts playTtsBase64 的口型同步思路。盪鞦韆隨 MOUTH_START 自動觸發（SpeakingMotionController）。
import { IPC } from "../../shared/ipc-channels";

const BUBBLE_HOLD_MS = 7000;

export class OpenerBubbleController {
  private bubbleEl: HTMLElement | null;
  private currentAudio: HTMLAudioElement | null = null;
  private mouthStopTimer: ReturnType<typeof setTimeout> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bubbleEl: HTMLElement) {
    this.bubbleEl = bubbleEl;
  }

  attach(): () => void {
    if (!window.live2dSpeech) return () => {};
    return window.live2dSpeech.onShowBubble((payload) => this.handle(payload));
  }

  public show(payload: { text: string; audioBase64?: string; format?: "wav" | "mp3"; durationMs?: number; sceneId?: string; itemId?: string }): void {
    if (!this.bubbleEl) return;
    this.stopCurrent();

    // prepare（停當前 motion + 嘴動 reset）
    window.live2dSpeech?.prepare();

    // 每日儀式即使未啟用 TTS，也要能以文字氣泡出現。
    if (!payload.audioBase64) {
      this.reveal(payload);
      return;
    }

    // 播 wav
    const mime = payload.format === "wav" ? "audio/wav" : "audio/mp3";
    const bytes = Uint8Array.from(atob(payload.audioBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.currentAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (this.currentAudio === audio) this.currentAudio = null;
      window.live2dSpeech?.stopMouth();
      this.fadeTimer = setTimeout(() => this.fadeOut(), BUBBLE_HOLD_MS);
    };

    void audio.play().then(() => {
      // 音訊真正開始播放時才顯示字幕，避免文字比聲音早出現。
      this.reveal(payload, false);
      const durationMs = Number.isFinite(audio.duration)
        ? Math.round(audio.duration * 1000)
        : Number(payload.durationMs ?? 0);
      window.live2dSpeech?.startMouth(durationMs);
      this.mouthStopTimer = setTimeout(() => {
        window.live2dSpeech?.stopMouth();
      }, durationMs + 500);
    }).catch((err) => {
      console.warn("[OpenerBubble] 播放失敗:", err);
      URL.revokeObjectURL(url);
      this.reveal(payload);
    });
  }

  private handle(payload: { text: string; audioBase64: string; format: "wav" | "mp3"; durationMs: number; sceneId: string; itemId: string }): void {
    this.show(payload);
  }

  private reveal(
    payload: { text: string; sceneId?: string; itemId?: string },
    scheduleFade = true,
  ): void {
    if (!this.bubbleEl) return;
    this.bubbleEl.textContent = payload.text;
    this.bubbleEl.hidden = false;
    this.bubbleEl.classList.add("opener-bubble--show");
    this.bubbleEl.onclick = payload.sceneId && payload.itemId
      ? () => window.openerBridge?.feedback({ type: "clicked", sceneId: payload.sceneId!, itemId: payload.itemId! })
      : null;
    if (scheduleFade) {
      this.fadeTimer = setTimeout(() => this.fadeOut(), BUBBLE_HOLD_MS + Math.min(8000, payload.text.length * 80));
    }
  }

  private fadeOut(): void {
    if (!this.bubbleEl) return;
    this.bubbleEl.classList.remove("opener-bubble--show");
    setTimeout(() => { if (this.bubbleEl) this.bubbleEl.hidden = true; }, 300);
  }

  private stopCurrent(): void {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    if (this.mouthStopTimer) { clearTimeout(this.mouthStopTimer); this.mouthStopTimer = null; }
    if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
    window.live2dSpeech?.stopMouth();
  }
}
