// 通話窗口渲染端 —— 粒子背景 + 麥克風採集 + VAD 靜默檢測 + 狀態機 + TTS 播放。
//
// 狀態：LISTENING（用戶說話）→ THINKING（agent 思考）→ SPEAKING（昔漣說話）→ LISTENING
// 用戶說話時：柱狀膠囊波形跳動 + 頭像外圈音量波形
// 昔漣說話時：電波環脈衝擴散 + 波形隱藏
import "../ui/theme";
import {
  callAudioMimeType,
  calibratedNoiseFloor,
  collectRecognitionText,
  keepPcmWorkletAlive,
  isFatalSpeechRecognitionError,
  speechOnsetThreshold,
  speechReleaseThreshold,
  timeDomainRms,
  type CallAudioFormat,
} from "./audio-utils";

// ── 粒子背景 ──
const canvas = document.getElementById("particles") as HTMLCanvasElement | null;
const ctx = canvas?.getContext("2d") ?? null;
let particlesW = 0, particlesH = 0;

interface Particle {
  x: number; y: number; size: number; vx: number; vy: number;
  hue: number; alpha: number; twinkle: number; twinkleSpeed: number;
}

const PARTICLE_COUNT = 45;
const particles: Particle[] = [];

function spawnParticle(): Particle {
  return {
    x: Math.random() * particlesW, y: Math.random() * particlesH,
    size: 0.6 + Math.random() * 2.4,
    vx: (Math.random() - 0.5) * 0.18,
    vy: -0.05 - Math.random() * 0.22,
    hue: 305 + Math.random() * 40,
    alpha: 0.25 + Math.random() * 0.5,
    twinkle: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.005 + Math.random() * 0.012,
  };
}

function resizeParticles(): void {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  // 直接用窗口尺寸，不依賴 clientWidth（可能被 body 層遮擋讀到錯誤值）
  particlesW = window.innerWidth;
  particlesH = window.innerHeight;
  canvas.width = particlesW * dpr;
  canvas.height = particlesH * dpr;
  canvas.style.width = particlesW + "px";
  canvas.style.height = particlesH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawParticles(): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, particlesW, particlesH);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.twinkle += p.twinkleSpeed;
    if (p.y < -10) p.y = particlesH + 10;
    if (p.x < -10) p.x = particlesW + 10;
    if (p.x > particlesW + 10) p.x = -10;
    const flicker = 0.65 + Math.sin(p.twinkle) * 0.35;
    const a = p.alpha * flicker;
    const r = p.size * 3;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, `hsla(${p.hue}, 90%, 80%, ${a})`);
    grad.addColorStop(0.5, `hsla(${p.hue}, 90%, 70%, ${a * 0.4})`);
    grad.addColorStop(1, `hsla(${p.hue}, 90%, 70%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(drawParticles);
}

// ── DOM 元素 ──
const statusEl = document.getElementById("call-status") as HTMLElement;
const ringEl = document.getElementById("avatar-ring") as HTMLElement;
const waveformCanvas = document.getElementById("waveform-canvas") as HTMLCanvasElement | null;
const micWaveEl = document.getElementById("mic-wave") as HTMLElement;
const micBars = micWaveEl ? Array.from(micWaveEl.querySelectorAll(".call__mic-wave-bar")) : [];
const transcriptEl = document.getElementById("transcript") as HTMLElement;
const hangupBtn = document.getElementById("hangup-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const durationEl = document.getElementById("call-duration") as HTMLElement | null;
const muteBtn = document.getElementById("mute-btn") as HTMLButtonElement;
const muteLabel = document.getElementById("mute-label") as HTMLElement;
const shareBtn = document.getElementById("share-btn") as HTMLButtonElement;
const shareLabel = document.getElementById("share-label") as HTMLElement;
const sharePreview = document.getElementById("share-preview") as HTMLElement;
const shareVideo = document.getElementById("share-video") as HTMLVideoElement;
const signalLabel = document.getElementById("signal-label") as HTMLElement;
const pttBtn = document.getElementById("ptt-btn") as HTMLButtonElement;
const pttLabel = document.getElementById("ptt-label") as HTMLElement;
const textBackupForm = document.getElementById("text-backup-form") as HTMLFormElement;
const textBackupInput = document.getElementById("text-backup-input") as HTMLInputElement;

// ── 通話時長計時（首次進入活動狀態時啟動，END 時停止） ──
let callStartAt: number | null = null;
let callTimer: number | null = null;

/** 把毫秒數格式化為 MM:SS，超過 60 分鐘進入 HH:MM:SS。 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 啟動 / 重置 計時器。第一次傳 true 時記錄起點並啟動 1s interval。 */
function startCallTimer(): void {
  if (callStartAt !== null) return; // 已經啟動過了，避免 LISTENING<->SPEAKING 時重置
  callStartAt = performance.now();
  if (durationEl) {
    durationEl.textContent = "00:00";
    durationEl.hidden = false;
  }
  const tick = () => {
    if (callStartAt === null || !durationEl) return;
    durationEl.textContent = formatDuration(performance.now() - callStartAt);
  };
  callTimer = window.setInterval(tick, 1000);
  tick();
}

/** 停止計時並隱藏時長元素（用於 hangup / 通話已結束）。 */
function stopCallTimer(): void {
  if (callTimer !== null) {
    window.clearInterval(callTimer);
    callTimer = null;
  }
  callStartAt = null;
  if (durationEl) durationEl.hidden = true;
}

// ── 狀態管理 ──
type CallState = "IDLE" | "LISTENING" | "THINKING" | "SYNTHESIZING" | "SPEAKING" | "ERROR" | "ENDED";
let currentState: CallState = "IDLE";
let showTranscript = false; // 從設置讀取

function setState(state: CallState): void {
  currentState = state;
  updateUI();
}

function updateUI(): void {
  const status = statusEl;
  const ring = ringEl;
  const wave = waveformCanvas;
  const mic = micWaveEl;

  if (currentState === "LISTENING") {
    status.textContent = hasSpoken ? "正在聆聽..." : "等待你說話...";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "listening";
    micMode = "listening";
  } else if (currentState === "THINKING") {
    status.textContent = "昔漣思考中...";
    status.className = "call__status call__status--thinking";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "thinking";
    micMode = "thinking";
  } else if (currentState === "SYNTHESIZING") {
    status.textContent = "正在準備語音...";
    status.className = "call__status call__status--thinking";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "thinking";
    micMode = "thinking";
  } else if (currentState === "SPEAKING") {
    status.textContent = "昔漣說話中...";
    status.className = "call__status";
    ring.classList.add("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else if (currentState === "ERROR") {
    status.textContent = "連接出錯，請檢查網絡";
    status.className = "call__status call__status--error";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else if (currentState === "ENDED") {
    status.textContent = "通話已結束";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else {
    status.textContent = "正在連接...";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  }

  // 通話時長：進入活動狀態時啟動計時，END 時停止（IDLE/ERROR/ENDED 均停）。
  if (currentState === "LISTENING" || currentState === "THINKING" || currentState === "SYNTHESIZING" || currentState === "SPEAKING") {
    startCallTimer();
  } else if (currentState === "ENDED") {
    stopCallTimer();
  }

  if (isMuted && currentState === "LISTENING") {
    status.textContent = "麥克風已靜音";
    mic.classList.remove("is-active");
  }
}

// ── 轉寫顯示（只顯示當前一輪） ──
function renderTranscript(userText: string, botText: string): void {
  if (!showTranscript) { transcriptEl.hidden = true; return; }
  transcriptEl.hidden = false;
  transcriptEl.innerHTML = "";
  if (userText) {
    const u = document.createElement("div");
    u.className = "call__transcript-user";
    u.textContent = userText;
    transcriptEl.appendChild(u);
  }
  if (botText) {
    const b = document.createElement("div");
    b.className = "call__transcript-bot";
    b.textContent = botText;
    transcriptEl.appendChild(b);
  }
}

let currentUserText = "";
let currentBotText = "";

// ── 音量波形（繞頭像一圈） ──
let waveformMode = "idle"; // idle, listening, thinking
const NUM_WAVE_BARS = 32;
const waveBars: Array<{ angle: number }> = [];
const waveformCtx = waveformCanvas?.getContext("2d") ?? null;

function initWaveformCanvas(): void {
  if (!waveformCanvas || !waveformCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const size = 200; // 比 avatar-zone(150px) 大一圈
  waveformCanvas.width = size * dpr;
  waveformCanvas.height = size * dpr;
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let i = 0; i < NUM_WAVE_BARS; i++) {
    waveBars.push({ angle: (i / NUM_WAVE_BARS) * Math.PI * 2 });
  }
}

let analyserData: Uint8Array | null = null;

function drawWaveform(): void {
  if (!waveformCtx || !waveformCanvas) { requestAnimationFrame(drawWaveform); return; }
  const cx = waveformCanvas.width / (window.devicePixelRatio || 1) / 2;
  const cy = waveformCanvas.height / (window.devicePixelRatio || 1) / 2;
  const innerRadius = 80; // 頭像半徑（150px / 2 ≈ 75，留一點邊）
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  for (const b of waveBars) {
    let h: number;
    if (waveformMode === "listening") {
      // 從 AnalyserNode 取頻域數據
      const dataIdx = Math.floor((b.angle / (Math.PI * 2)) * (analyserData?.length ?? 1));
      const vol = analyserData ? analyserData[dataIdx] / 255 : 0;
      h = 5 + vol * 85;
    } else if (waveformMode === "thinking") {
      h = 5 + Math.sin(Date.now() * 0.003 + b.angle) * 4 + 4;
    } else {
      h = 5;
    }
    const x1 = cx + Math.cos(b.angle) * innerRadius;
    const y1 = cy + Math.sin(b.angle) * innerRadius;
    const x2 = cx + Math.cos(b.angle) * (innerRadius + h);
    const y2 = cy + Math.sin(b.angle) * (innerRadius + h);
    waveformCtx.strokeStyle = "rgba(255, 110, 199, 0.7)";
    waveformCtx.lineWidth = 3;
    waveformCtx.lineCap = "round";
    waveformCtx.beginPath();
    waveformCtx.moveTo(x1, y1);
    waveformCtx.lineTo(x2, y2);
    waveformCtx.stroke();
  }
  requestAnimationFrame(drawWaveform);
}

// ── 柱狀膠囊波形動畫 ──
let micMode = "idle"; // idle, listening, thinking

function animateMicWave(): void {
  for (const bar of micBars) {
    let h: number;
    if (micMode === "listening") {
      // 從 AnalyserNode 取平均音量
      const avg = analyserData ? analyserData.reduce((a, b) => a + b, 0) / analyserData.length / 255 : 0;
      h = 10 + Math.random() * avg * 76 + avg * 20;
    } else if (micMode === "thinking") {
      h = 10 + Math.sin(Date.now() * 0.004) * 5 + 5;
    } else {
      h = 10;
    }
    (bar as HTMLElement).style.height = h + "px";
  }
  requestAnimationFrame(animateMicWave);
}

// ── 麥克風採集 + VAD ──
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let analyserTimeData: Uint8Array | null = null;
let workletNode: AudioWorkletNode | null = null;
let micStream: MediaStream | null = null;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let vadInterval: ReturnType<typeof setInterval> | null = null;
let vadSilenceMs = 1000;
let noiseFloor = 0.015; // 初始噪音底噪估計
let vadThreshold = 0.035; // 初始判斷閾值
let hasSpoken = false; // 用戶是否已開始說話（VAD 只在說過話後檢測靜默）
let pcmPreroll: ArrayBuffer[] = [];
let asrEngine = "local"; // local, aliyun, web-speech, off
let recognition: any = null;
let recognitionText = "";
let webSpeechTurnPending = false;
let webSpeechTurnFallback: ReturnType<typeof setTimeout> | null = null;
let webSpeechFatalError = false;
let webSpeechStarting = false;
let isMuted = false;
let pushToTalk = false;
let pttActive = false;
let displayStream: MediaStream | null = null;

async function startMicrophone(): Promise<void> {
  try {
    // 先列出所有音訊輸入設備，列印在 Console 中方便診斷
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === "audioinput");
      console.log("[Call] 偵測到的麥克風輸入設備列表:", audioInputs.map(d => ({ label: d.label || "（未授權，請先允許錄音權限）", id: d.deviceId })));
    } catch (e) {
      console.warn("[Call] 無法列出麥克風設備:", e);
    }

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    const pcmProcessorUrl = import.meta.env.DEV
      ? "/pcm-processor.js"
      : new URL(/* @vite-ignore */ "../pcm-processor.js", import.meta.url).toString();
    await audioContext.audioWorklet.addModule(pcmProcessorUrl);

    const source = audioContext.createMediaStreamSource(micStream);

    // AnalyserNode 用於 VAD + 波形顯示
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    analyserTimeData = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    // AudioWorkletNode 用於 PCM 採集
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    workletNode.port.onmessage = (e: MessageEvent) => {
      const frame = e.data as ArrayBuffer;
      if (!isMuted && asrEngine !== "off") {
        if (pushToTalk) {
          if (pttActive) window.call?.sendAudioFrame(frame);
        } else if (hasSpoken) {
          window.call?.sendAudioFrame(frame);
        } else {
          // 等確認是人聲才送出；保留約 600ms 預錄，避免吃掉第一個字。
          pcmPreroll.push(frame);
          if (pcmPreroll.length > 60) pcmPreroll.shift();
        }
      }
    };
    source.connect(workletNode);
    // Web Audio 圖是由 destination 向上游拉取的；未連接輸出時 Chromium
    // 可能剪掉 Worklet，導致 port.onmessage 永遠收不到 PCM。
    // PCMProcessor 沒有寫入 outputs，因此連到 destination 仍是靜音，不會麥克風回放。
    keepPcmWorkletAlive(workletNode, audioContext.destination);

    // 確保恢復 AudioContext 運行狀態，避免 Chromium 默認的 suspended 策略攔截音訊處理
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    console.log("[Call] 麥克風已啟動");
    startVAD();
  } catch (err) {
    console.error("[Call] 麥克風啟動失敗:", err);
    statusEl.textContent = "無法訪問麥克風，請檢查權限";
    statusEl.className = "call__status call__status--error";
  }
}

/** VAD 靜默檢測：連續 N ms 低於閾值判定說完（採用自適應底噪演算法） */
function startVAD(): void {
  let logCounter = 0;
  let speechCandidateFrames = 0;
  const calibrationSamples: number[] = [];
  const calibrationFrameCount = 12; // 前 1.2 秒只校準，不觸發說話
  const requiredSpeechFrames = 3; // 連續 300ms 才視為開始說話
  hasSpoken = false;
  pcmPreroll = [];
  statusEl.textContent = "正在校準麥克風...";

  if (vadInterval) clearInterval(vadInterval);
  vadInterval = setInterval(() => {
    if (!analyser || !analyserTimeData) return;
    if (currentState !== "LISTENING") return;
    if (isMuted) return;
    if (pushToTalk) return;
    if (asrEngine === "web-speech" && (webSpeechFatalError || webSpeechStarting)) return;

    if (analyserData) analyser.getByteFrequencyData(analyserData);
    analyser.getByteTimeDomainData(analyserTimeData);
    const level = timeDomainRms(analyserTimeData);

    if (calibrationSamples.length < calibrationFrameCount) {
      calibrationSamples.push(level);
      noiseFloor = calibratedNoiseFloor(calibrationSamples);
      vadThreshold = speechOnsetThreshold(noiseFloor);
      if (calibrationSamples.length === calibrationFrameCount) {
        console.log(`[VAD] 校準完成 | 底噪 RMS: ${noiseFloor.toFixed(4)} | 啟動閾值: ${vadThreshold.toFixed(4)}`);
        if (asrEngine !== "web-speech" || (!webSpeechStarting && !webSpeechFatalError)) {
          statusEl.textContent = "等待你說話...";
        }
      }
      return;
    }

    const onsetThreshold = speechOnsetThreshold(noiseFloor);
    const releaseThreshold = speechReleaseThreshold(noiseFloor);
    vadThreshold = hasSpoken ? releaseThreshold : onsetThreshold;

    // 每秒在 Console 印一次 VAD 診斷日誌，方便直接觀察
    logCounter++;
    if (logCounter >= 10) {
      logCounter = 0;
      console.log(`[VAD] RMS: ${level.toFixed(4)} | 底噪: ${noiseFloor.toFixed(4)} | 閾值: ${vadThreshold.toFixed(4)} | 說話狀態: ${hasSpoken}`);
    }

    if (!hasSpoken) {
      if (level >= onsetThreshold) {
        speechCandidateFrames += 1;
      } else {
        speechCandidateFrames = 0;
        // 只用低於啟動閾值的樣本緩慢追蹤環境底噪，避免把人聲學成底噪。
        noiseFloor = Math.max(0.003, Math.min(0.12, noiseFloor * 0.97 + level * 0.03));
      }

      if (speechCandidateFrames >= requiredSpeechFrames) {
        hasSpoken = true;
        speechCandidateFrames = 0;
        for (const frame of pcmPreroll) window.call?.sendAudioFrame(frame);
        pcmPreroll = [];
        statusEl.textContent = "正在聆聽...";
        console.log("[VAD] 已確認連續人聲，開始本輪");
      }
      return;
    }

    if (level >= releaseThreshold) {
      if (vadSilenceTimer) {
        clearTimeout(vadSilenceTimer);
        vadSilenceTimer = null;
      }
    } else if (hasSpoken) {
      // 靜默且之前說過話：開始靜默計時
      if (!vadSilenceTimer) {
        vadSilenceTimer = setTimeout(() => {
          console.log("[Call] VAD 靜默檢測觸發，結束本輪");
          sendSharedScreenFrame();
          window.call?.turnEnd();
          vadSilenceTimer = null;
          hasSpoken = false;
          pcmPreroll = [];
        }, vadSilenceMs);
      }
    }
  }, 100);
}

// ── 靜音與畫面分享 ──
function resetVadTurn(): void {
  if (vadSilenceTimer) {
    clearTimeout(vadSilenceTimer);
    vadSilenceTimer = null;
  }
  hasSpoken = false;
  pcmPreroll = [];
}

function toggleMute(): void {
  isMuted = !isMuted;
  micStream?.getAudioTracks().forEach((track) => { track.enabled = !isMuted; });
  muteBtn.classList.toggle("is-active", isMuted);
  muteBtn.setAttribute("aria-pressed", String(isMuted));
  muteBtn.title = isMuted ? "取消靜音" : "麥克風靜音";
  muteLabel.textContent = isMuted ? "取消靜音" : "靜音";

  if (isMuted) {
    resetVadTurn();
    statusEl.textContent = "麥克風已靜音";
    micWaveEl.classList.remove("is-active");
  } else if (currentState === "LISTENING") {
    statusEl.textContent = "等待你說話...";
    micWaveEl.classList.add("is-active");
  }
}

function beginPushToTalk(): void {
  if (!pushToTalk || pttActive || isMuted || currentState !== "LISTENING") return;
  pttActive = true;
  resetVadTurn();
  hasSpoken = true;
  pttBtn.classList.add("is-active");
  pttBtn.setAttribute("aria-pressed", "true");
  pttLabel.textContent = "放開送出";
  statusEl.textContent = "正在收音…";
}

function endPushToTalk(): void {
  if (!pttActive) return;
  pttActive = false;
  pttBtn.classList.remove("is-active");
  pttBtn.setAttribute("aria-pressed", "false");
  pttLabel.textContent = "按住說話";
  hasSpoken = false;
  sendSharedScreenFrame();
  window.call?.turnEnd();
}

function captureSharedScreenFrame(): string | null {
  if (!displayStream || shareVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const sourceWidth = shareVideo.videoWidth;
  const sourceHeight = shareVideo.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  const maxWidth = 1280;
  const scale = Math.min(1, maxWidth / sourceWidth);
  const frame = document.createElement("canvas");
  frame.width = Math.max(1, Math.round(sourceWidth * scale));
  frame.height = Math.max(1, Math.round(sourceHeight * scale));
  frame.getContext("2d")?.drawImage(shareVideo, 0, 0, frame.width, frame.height);
  return frame.toDataURL("image/jpeg", 0.72);
}

function sendSharedScreenFrame(): void {
  const frame = captureSharedScreenFrame();
  if (frame) window.call?.sendScreenFrame(frame);
}

function stopScreenShare(): void {
  // 先清空參照再 stop；track.stop() 可能同步觸發 ended，避免清理流程重入。
  const stream = displayStream;
  displayStream = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  shareVideo.srcObject = null;
  sharePreview.hidden = true;
  shareBtn.classList.remove("is-active");
  shareBtn.setAttribute("aria-pressed", "false");
  shareBtn.title = "分享畫面";
  shareLabel.textContent = "分享畫面";
  signalLabel.textContent = "語音連線已加密";
  window.call?.sendScreenFrame(null);
}

async function toggleScreenShare(): Promise<void> {
  if (displayStream) {
    stopScreenShare();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      return;
    }
    displayStream = stream;
    shareVideo.srcObject = stream;
    await shareVideo.play().catch(() => undefined);
    sharePreview.hidden = false;
    shareBtn.classList.add("is-active");
    shareBtn.setAttribute("aria-pressed", "true");
    shareBtn.title = "停止分享";
    shareLabel.textContent = "停止分享";
    signalLabel.textContent = "畫面已連結 · 提到畫面時昔漣可以看見";
    track.addEventListener("ended", stopScreenShare, { once: true });
    sendSharedScreenFrame();
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "unknown";
    if (name !== "NotAllowedError") console.error("[Call] 畫面分享失敗:", error);
    statusEl.textContent = name === "NotAllowedError" ? "已取消畫面分享" : "無法分享畫面，請檢查系統權限";
  }
}

function stopMicrophone(): void {
  if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
  if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
  pcmPreroll = [];
  hasSpoken = false;
  if (workletNode) { try { workletNode.disconnect(); } catch { /* ignore */ } workletNode = null; }
  if (analyser) { try { analyser.disconnect(); } catch { /* ignore */ } analyser = null; }
  analyserTimeData = null;
  if (audioContext) { try { audioContext.close(); } catch { /* ignore */ } audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  webSpeechTurnPending = false;
  webSpeechFatalError = false;
  webSpeechStarting = false;
  if (webSpeechTurnFallback) {
    clearTimeout(webSpeechTurnFallback);
    webSpeechTurnFallback = null;
  }
  if (asrEngine === "web-speech" && recognition) {
    try { recognition.abort(); } catch { /* ignore */ }
    recognition = null;
  }
}

function submitWebSpeechTurn(): void {
  if (!webSpeechTurnPending) return;
  webSpeechTurnPending = false;
  if (webSpeechTurnFallback) {
    clearTimeout(webSpeechTurnFallback);
    webSpeechTurnFallback = null;
  }
  const text = recognitionText.trim();
  recognitionText = "";
  window.call?.turnEnd(text);
}

function finishWebSpeechTurn(): void {
  if (webSpeechFatalError) return;
  if (webSpeechTurnPending) return;
  webSpeechTurnPending = true;
  // stop() 會要求瀏覽器先產生最後一個 result，再觸發 onend。
  // 逾時保險處理某些 Chromium 版本不觸發 onend 的情況。
  webSpeechTurnFallback = setTimeout(submitWebSpeechTurn, 500);
  try {
    recognition?.stop();
  } catch {
    submitWebSpeechTurn();
  }
}

async function ensureOnDeviceSpeech(SpeechRecognition: any): Promise<string | null> {
  if (typeof SpeechRecognition.available !== "function" || typeof SpeechRecognition.install !== "function") {
    return null;
  }

  for (const lang of ["zh-TW", "zh-CN"]) {
    try {
      const options = { langs: [lang], processLocally: true };
      const availability = await SpeechRecognition.available(options);
      console.log(`[WebSpeech] ${lang} 本機語言包狀態:`, availability);
      if (availability === "available") return lang;
      if (availability === "downloadable" || availability === "downloading") {
        statusEl.textContent = `正在安裝 ${lang} 離線語音包...`;
        const installed = await SpeechRecognition.install(options);
        if (installed) return lang;
      }
    } catch (error) {
      console.warn(`[WebSpeech] ${lang} 本機語言包檢查失敗:`, error);
    }
  }
  return null;
}

function showWebSpeechFatalError(error: string): void {
  webSpeechFatalError = true;
  webSpeechTurnPending = false;
  hasSpoken = false;
  if (vadSilenceTimer) {
    clearTimeout(vadSilenceTimer);
    vadSilenceTimer = null;
  }
  const message = error === "network"
    ? "此版 Electron 無法連接 Web Speech；本機語音包也不可用"
    : error === "language-not-supported"
      ? "此版 Electron 沒有可用的中文離線語音包"
      : "Web Speech 無法使用：" + error;
  statusEl.textContent = message;
  statusEl.className = "call__status call__status--error";
  console.error("[WebSpeech] 已停止自動重試:", message);
  try { recognition?.abort(); } catch { /* ignore */ }
}

async function startWebSpeech(): Promise<void> {
  if (webSpeechStarting || webSpeechFatalError) return;
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.error("[Call] 瀏覽器不支援 Web Speech API");
    statusEl.textContent = "瀏覽器不支援 Web Speech API";
    return;
  }
  webSpeechStarting = true;
  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    statusEl.textContent = "正在檢查離線語音包...";
    const localLanguage = await ensureOnDeviceSpeech(SpeechRecognition);
    if (!localLanguage) {
      webSpeechStarting = false;
      showWebSpeechFatalError("language-not-supported");
      return;
    }
    recognition.lang = localLanguage;
    recognition.processLocally = true;
    console.log(`[WebSpeech] 使用本機辨識: ${localLanguage}`);

    recognition.onresult = (event: any) => {
      // 每次由完整 results 重建文字；continuous 模式的 resultIndex 只指向
      // 本次變更位置，只從那裡讀會把前面已確認的句子覆蓋掉。
      const { combined } = collectRecognitionText(event.results);
      const currentResult = combined;
      if (currentResult) {
        recognitionText = combined;
        console.log("[WebSpeech] 識別結果:", recognitionText);
        currentUserText = recognitionText;
        renderTranscript(currentUserText, "");

        // 收到識別字，代表正在說話：標記 hasSpoken，重置靜默計時
        hasSpoken = true;
        if (vadSilenceTimer) {
          clearTimeout(vadSilenceTimer);
          vadSilenceTimer = null;
        }
      }
    };

    recognition.onerror = (event: any) => {
      console.error("[WebSpeech] 語音識別錯誤:", event.error);
      if (isFatalSpeechRecognitionError(String(event.error))) {
        showWebSpeechFatalError(String(event.error));
      }
    };

    recognition.onend = () => {
      if (webSpeechTurnPending) {
        submitWebSpeechTurn();
        return;
      }
      // 若依然在 LISTENING 狀態，自動重啟以防止 Web Speech API 逾時關閉
      if (currentState === "LISTENING" && asrEngine === "web-speech" && recognition && !webSpeechFatalError) {
        try { recognition.start(); } catch { /* ignore */ }
      }
    };
  }

  try {
    recognition.start();
    statusEl.textContent = "等待你說話...";
    console.log("[WebSpeech] 本機 Web Speech 語音識別已啟動");
  } catch (e) {
    console.error("[WebSpeech] 啟動失敗:", e);
    showWebSpeechFatalError("start-failed");
  } finally {
    webSpeechStarting = false;
  }
}

// ── TTS 播放 + Live2D 嘴型聯動 ──
// 複用聊天窗口的邏輯：音頻播放時通過 live2dSpeech IPC 讓寵物窗口小人嘴巴張合。
const AUDIO_MOUTH_DELAY_MS = 800;

let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl: string | null = null;
const ttsAudioQueue: Array<{ base64: string; format: CallAudioFormat; isFinal: boolean }> = [];
let speechToken = 0;

function nextSpeechToken(): number {
  speechToken += 1;
  return speechToken;
}

/** 停止嘴型聯動（掛斷 / 新 TTS / 錯誤時調用）。 */
function stopLive2dMouth(): void {
  speechToken += 1;
  window.live2dSpeech?.stopMouth();
}

function waitForAudioMetadata(audio: HTMLAudioElement): Promise<number | null> {
  return new Promise((resolve) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      resolve(audio.duration);
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 3000);
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
  });
}

function playNextTtsAudio(): void {
  if (currentAudio || ttsAudioQueue.length === 0) return;
  const { base64, format, isFinal } = ttsAudioQueue.shift()!;
  stopLive2dMouth();

  const token = nextSpeechToken();
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const mimeType = callAudioMimeType(format);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.load();
  currentAudio = audio;
  currentAudioUrl = url;

  // 重置表情，準備嘴型聯動
  window.live2dSpeech?.prepare();

  let finished = false;
  const finishSegment = () => {
    if (finished) return;
    finished = true;
    URL.revokeObjectURL(url);
    if (currentAudio === audio) {
      currentAudio = null;
      currentAudioUrl = null;
    }
    if (speechToken === token) stopLive2dMouth();
    if (ttsAudioQueue.length > 0) {
      playNextTtsAudio();
    } else if (isFinal) {
      window.call?.ttsDone();
    }
  };
  audio.onended = finishSegment;
  audio.onerror = finishSegment;
  audio.play().catch(() => {
    finishSegment();
  });

  // 等音頻 metadata 獲取時長，延遲後驅動嘴型
  void (async () => {
    const durationSec = await waitForAudioMetadata(audio);
    if (speechToken !== token) return;
    const durationMs = durationSec === null ? 0 : Math.max(0, durationSec * 1000 - AUDIO_MOUTH_DELAY_MS);
    window.setTimeout(() => {
      if (speechToken !== token) return;
      if (durationMs > 0) window.live2dSpeech?.startMouth(durationMs);
    }, AUDIO_MOUTH_DELAY_MS);
  })();
}

function enqueueTtsAudio(base64: string, format: CallAudioFormat, isFinal: boolean): void {
  ttsAudioQueue.push({ base64, format, isFinal });
  playNextTtsAudio();
}

function stopTts(): void {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
  ttsAudioQueue.length = 0;
  stopLive2dMouth();
}

// ── IPC 事件監聽 ──
window.call?.onState((state: string) => {
  setState(state as CallState);
  if (state === "LISTENING") {
    if (!micStream) {
      void startMicrophone();
    }
  } else if (state === "THINKING" || state === "SYNTHESIZING" || state === "SPEAKING" || state === "IDLE" || state === "ENDED") {
    // PCM/Whisper 模式由主程序按通話狀態管理，不需要 renderer 語音服務。
  }
});

window.call?.onAsrResult((data: { partial?: string; final?: string }) => {
  if (data.partial) {
    currentUserText = data.partial;
    renderTranscript(currentUserText, "");
  }
  if (data.final) {
    currentUserText = data.final;
    renderTranscript(currentUserText, "");
  }
});

window.call?.onTtsAudio((data: { base64: string; format: "wav" | "mp3"; isFinal: boolean }) => {
  renderTranscript(currentUserText, "（語音回覆中）");
  enqueueTtsAudio(data.base64, data.format, data.isFinal);
});

window.call?.onError((data: { message: string }) => {
  stopTts();
  statusEl.textContent = data.message;
  statusEl.className = "call__status call__status--error";
});

// ── 掛斷 ──
function hangup(): void {
  window.call?.stop();
  stopScreenShare();
  stopMicrophone();
  stopTts();
  stopCallTimer();
  setState("ENDED");
  setTimeout(() => window.close(), 500);
}

hangupBtn.addEventListener("click", hangup);
closeBtn.addEventListener("click", hangup);
muteBtn.addEventListener("click", toggleMute);
shareBtn.addEventListener("click", () => { void toggleScreenShare(); });
pttBtn.addEventListener("pointerdown", (event) => { event.preventDefault(); beginPushToTalk(); });
for (const eventName of ["pointerup", "pointercancel", "pointerleave"] as const) pttBtn.addEventListener(eventName, endPushToTalk);
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || document.activeElement === textBackupInput) return;
  event.preventDefault();
  beginPushToTalk();
});
window.addEventListener("keyup", (event) => {
  if (event.code !== "Space" || document.activeElement === textBackupInput) return;
  event.preventDefault();
  endPushToTalk();
});
textBackupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textBackupInput.value.trim();
  if (!text || currentState !== "LISTENING") return;
  currentUserText = text;
  renderTranscript(text, "");
  textBackupInput.value = "";
  sendSharedScreenFrame();
  window.call?.turnEnd(text);
});

// ── 初始化 ──
async function init(): Promise<void> {
  // 讀 ASR 設置（VAD 閾值 + 轉寫開關）
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg) {
      vadSilenceMs = typeof cfg.asrVadSilenceMs === "number" ? cfg.asrVadSilenceMs : 1000;
      showTranscript = Boolean(cfg.asrShowTranscript);
      asrEngine = typeof cfg.asrEngine === "string" ? cfg.asrEngine : "local";
      pushToTalk = Boolean(cfg.asrPushToTalk);
    }
  } catch { /* ignore */ }
  pttBtn.hidden = !pushToTalk;

  // 粒子背景
  if (canvas && ctx) {
    resizeParticles();
    for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(spawnParticle());
    requestAnimationFrame(drawParticles);
    window.addEventListener("resize", resizeParticles);
  }

  // 波形 canvas
  initWaveformCanvas();
  requestAnimationFrame(drawWaveform);
  requestAnimationFrame(animateMicWave);

  // 開始通話
  window.call?.start();
}

void init();

// 窗口類型聲明
declare global {
  interface Window {
    call?: {
      start: () => void;
      sendAudioFrame: (frame: ArrayBuffer) => void;
      sendScreenFrame: (dataUrl: string | null) => void;
      turnEnd: (text?: string) => void;
      ttsDone: () => void;
      stop: () => void;
      onState: (callback: (state: string) => void) => () => void;
      onAsrResult: (callback: (data: { partial?: string; final?: string }) => void) => () => void;
      onTtsAudio: (callback: (data: { base64: string; format: "wav" | "mp3"; isFinal: boolean }) => void) => () => void;
      onError: (callback: (data: { message: string }) => void) => () => void;
    };
    tts?: {
      loadSettings: () => Promise<Record<string, unknown>>;
    };
    live2dSpeech?: {
      prepare: () => void;
      startMouth: (durationMs: number) => void;
      stopMouth: () => void;
    };
  }
}
