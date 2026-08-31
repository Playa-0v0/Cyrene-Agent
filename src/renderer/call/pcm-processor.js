// AudioWorklet PCM 采集器 —— 采集麦克风音频，输出 16kHz/16bit/mono PCM 帧。
//
// 每 20ms（sampleRate=16000 → 320 samples）postMessage 一个 Int16Array buffer。
// 渲染端收到后转 ArrayBuffer 通过 IPC CALL_AUDIO_FRAME 发给主进程。

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 16kHz, 20ms = 320 samples per frame
    this._frameSize = 320;
    this._buffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0]; // mono
    if (!channel) return true;

    // 累积样本
    for (let i = 0; i < channel.length; i++) {
      // Float32 (-1.0~1.0) → Int16 (-32768~32767)
      const s = Math.max(-1, Math.min(1, channel[i]));
      this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7FFF);
    }

    // 凑够一帧就发送
    while (this._buffer.length >= this._frameSize) {
      const frame = this._buffer.splice(0, this._frameSize);
      const int16 = new Int16Array(frame);
      // 发 ArrayBuffer 给主线程
      this.port.postMessage(int16.buffer);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
