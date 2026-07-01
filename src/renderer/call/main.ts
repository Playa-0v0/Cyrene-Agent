// 通话窗口渲染端 —— 粒子背景 + 麦克风采集 + VAD 静默检测 + 状态机 + TTS 播放。
//
// 状态：LISTENING（用户说话）→ THINKING（agent 思考）→ SPEAKING（昔涟说话）→ LISTENING
// 用户说话时：柱状胶囊波形跳动 + 头像外圈音量波形
// 昔涟说话时：电波环脉冲扩散 + 波形隐藏

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
  // 直接用窗口尺寸，不依赖 clientWidth（可能被 body 层遮挡读到错误值）
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

// ── 状态管理 ──
type CallState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR" | "ENDED";
let currentState: CallState = "IDLE";
let showTranscript = false; // 从设置读取

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
    status.textContent = "正在聆听...";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "listening";
    micMode = "listening";
  } else if (currentState === "THINKING") {
    status.textContent = "昔涟思考中...";
    status.className = "call__status call__status--thinking";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "thinking";
    micMode = "thinking";
  } else if (currentState === "SPEAKING") {
    status.textContent = "昔涟说话中...";
    status.className = "call__status";
    ring.classList.add("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else if (currentState === "ERROR") {
    status.textContent = "连接出错，请检查网络";
    status.className = "call__status call__status--error";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else if (currentState === "ENDED") {
    status.textContent = "通话已结束";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else {
    status.textContent = "正在连接...";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  }
}

// ── 转写显示（只显示当前一轮） ──
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

// ── 音量波形（绕头像一圈） ──
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
  const innerRadius = 80; // 头像半径（150px / 2 ≈ 75，留一点边）
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  for (const b of waveBars) {
    let h: number;
    if (waveformMode === "listening") {
      // 从 AnalyserNode 取频域数据
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

// ── 柱状胶囊波形动画 ──
let micMode = "idle"; // idle, listening, thinking

function animateMicWave(): void {
  for (const bar of micBars) {
    let h: number;
    if (micMode === "listening") {
      // 从 AnalyserNode 取平均音量
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

// ── 麦克风采集 + VAD ──
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let micStream: MediaStream | null = null;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let vadSilenceMs = 1000;
let vadThreshold = 0.02; // 音量阈值
let hasSpoken = false; // 用户是否已开始说话（VAD 只在说过话后检测静默）

async function startMicrophone(): Promise<void> {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule(new URL("./pcm-processor.js", import.meta.url));

    const source = audioContext.createMediaStreamSource(micStream);

    // AnalyserNode 用于 VAD + 波形显示
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    // AudioWorkletNode 用于 PCM 采集
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    workletNode.port.onmessage = (e: MessageEvent) => {
      const frame = e.data as ArrayBuffer;
      window.call?.sendAudioFrame(frame);
    };
    source.connect(workletNode);
    // workletNode 不连 destination（不需要本地回放）

    console.log("[Call] 麦克风已启动");
    startVAD();
  } catch (err) {
    console.error("[Call] 麦克风启动失败:", err);
    statusEl.textContent = "无法访问麦克风，请检查权限";
    statusEl.className = "call__status call__status--error";
  }
}

/** VAD 静默检测：连续 N ms 低于阈值判定说完 */
function startVAD(): void {
  const checkInterval = setInterval(() => {
    if (!analyser || !analyserData) return;
    if (currentState !== "LISTENING") return;

    analyser.getByteFrequencyData(analyserData);
    // 计算平均音量
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
    const avg = sum / analyserData.length / 255;

    if (avg >= vadThreshold) {
      // 有声音：标记已开始说话，重置静默计时
      hasSpoken = true;
      if (vadSilenceTimer) {
        clearTimeout(vadSilenceTimer);
        vadSilenceTimer = null;
      }
    } else if (hasSpoken) {
      // 静默且之前说过话：开始静默计时
      if (!vadSilenceTimer) {
        vadSilenceTimer = setTimeout(() => {
          console.log("[Call] VAD 静默检测触发，结束本轮");
          window.call?.turnEnd();
          vadSilenceTimer = null;
          hasSpoken = false;
        }, vadSilenceMs);
      }
    }
  }, 100);
}

function stopMicrophone(): void {
  if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
  if (workletNode) { try { workletNode.disconnect(); } catch { /* ignore */ } workletNode = null; }
  if (analyser) { try { analyser.disconnect(); } catch { /* ignore */ } analyser = null; }
  if (audioContext) { try { audioContext.close(); } catch { /* ignore */ } audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
}

// ── TTS 播放 + Live2D 嘴型联动 ──
// 复用聊天窗口的逻辑：音频播放时通过 live2dSpeech IPC 让宠物窗口小人嘴巴张合。
const AUDIO_MOUTH_DELAY_MS = 800;

let currentAudio: HTMLAudioElement | null = null;
let speechToken = 0;

function nextSpeechToken(): number {
  speechToken += 1;
  return speechToken;
}

/** 停止嘴型联动（挂断 / 新 TTS / 错误时调用）。 */
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

function playTtsAudio(base64: string): void {
  // 停掉旧音频和嘴型
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  stopLive2dMouth();

  const token = nextSpeechToken();
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "audio/mp3" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.load();
  currentAudio = audio;

  // 重置表情，准备嘴型联动
  window.live2dSpeech?.prepare();

  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
    if (speechToken === token) stopLive2dMouth();
    window.call?.ttsDone();
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
    if (speechToken === token) stopLive2dMouth();
    window.call?.ttsDone();
  };
  audio.play().catch(() => {
    if (speechToken === token) stopLive2dMouth();
    window.call?.ttsDone();
  });

  // 等音频 metadata 获取时长，延迟后驱动嘴型
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

function stopTts(): void {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  stopLive2dMouth();
}

// ── IPC 事件监听 ──
window.call?.onState((state: string) => {
  setState(state as CallState);
  if (state === "LISTENING" && !micStream) {
    void startMicrophone();
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

window.call?.onTtsAudio((data: { base64: string }) => {
  renderTranscript(currentUserText, "（语音回复中）");
  playTtsAudio(data.base64);
});

window.call?.onError((data: { message: string }) => {
  statusEl.textContent = data.message;
  statusEl.className = "call__status call__status--error";
});

// ── 挂断 ──
function hangup(): void {
  window.call?.stop();
  stopMicrophone();
  stopTts();
  setState("ENDED");
  setTimeout(() => window.close(), 500);
}

hangupBtn.addEventListener("click", hangup);
closeBtn.addEventListener("click", hangup);

// ── 初始化 ──
async function init(): Promise<void> {
  // 读 ASR 设置（VAD 阈值 + 转写开关）
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg) {
      vadSilenceMs = typeof cfg.asrVadSilenceMs === "number" ? cfg.asrVadSilenceMs : 1000;
      showTranscript = Boolean(cfg.asrShowTranscript);
    }
  } catch { /* ignore */ }

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

  // 开始通话
  window.call?.start();
}

void init();

// 窗口类型声明
declare global {
  interface Window {
    call?: {
      start: () => void;
      sendAudioFrame: (frame: ArrayBuffer) => void;
      turnEnd: () => void;
      ttsDone: () => void;
      stop: () => void;
      onState: (callback: (state: string) => void) => () => void;
      onAsrResult: (callback: (data: { partial?: string; final?: string }) => void) => () => void;
      onTtsAudio: (callback: (data: { base64: string }) => void) => () => void;
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
