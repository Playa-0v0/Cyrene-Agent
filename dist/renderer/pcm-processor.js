// AudioWorklet PCM 採集器 —— 採集麥克風音頻，輸出 16kHz/16bit/mono PCM 幀。
//
// 每 20ms（sampleRate=16000 → 320 samples）postMessage 一個 Int16Array buffer。
// 渲染端收到後轉 ArrayBuffer 通過 IPC CALL_AUDIO_FRAME 發給主進程。

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

    // 累積樣本
    for (let i = 0; i < channel.length; i++) {
      // Float32 (-1.0~1.0) → Int16 (-32768~32767)
      const s = Math.max(-1, Math.min(1, channel[i]));
      this._buffer.push(s < 0 ? s * 0x8000 : s * 0x7FFF);
    }

    // 湊夠一幀就發送
    while (this._buffer.length >= this._frameSize) {
      const frame = this._buffer.splice(0, this._frameSize);
      const int16 = new Int16Array(frame);
      // 發 ArrayBuffer 給主線程
      this.port.postMessage(int16.buffer);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
