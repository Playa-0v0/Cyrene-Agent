import { encodePcm16MonoWav } from "./mossland-asr-engine";

/**
 * 本地 FunASR 服务默认基址。
 *
 * 配套服务端脚本随本仓库分发：`scripts/local-asr-server/asr_server.py`
 *   （FastAPI，默认监听 127.0.0.1:8328，部署方式见同目录 README.md）
 *
 * 历史包袱：早期 `settings-facade.ts` 与 `asrEngine` 白名单已经把 `"local"` 列入合法值，
 * 但分发器一直没有 local 分支，UI 下拉框也长期挂着「占位，敬请期待」。
 * 本 PR 借 mossland 已有 `MosslandAsrStream` 的批量转写形态，把这个官方预留的「插座」接上电。
 */
export const DEFAULT_LOCAL_ASR_URL = "http://127.0.0.1:8328";

/**
 * 规范化用户填写的服务地址：去掉末尾斜杠。
 * `http://127.0.0.1:8328/` 与 `http://127.0.0.1:8328` 应指向同一个服务，
 * 直接字符串拼接前先归一，避免拼出 `//v1/audio/transcriptions` 这种路径。
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * `GET /status` 探测超时：设置短（2s）即可，目的是给用户一个清楚的「服务未启动」
 * 提示，不需要等到 30 秒才发现连不上。
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * `POST /v1/audio/transcriptions` 转写超时：FunASR paraformer-large 在 CPU 上
 * 处理一段 30 秒左右的微信语音通常需要 15~25 秒，GPU 上 ~3~8 秒，给 30 秒留够余量。
 * 如果切到更重的模型再做调整。
 */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * 把缓存的 PCM 数据 POST 到本地服务做一次整段转写。
 *
 * 协议与 OpenAI `/v1/audio/transcriptions` 兼容：
 *   - multipart/form-data
 *   - field `model`           服务端不消费，但保持与 OpenAI 客户端一致的字段
 *   - field `response_format` 服务端固定返回 JSON，目前不需要此字段
 *   - field `file`            完整 WAV 字节流（44 字节 header + PCM 裸数据）
 *
 * 为什么不复用 mossland 那套走自家 `mosslandFetch`/`buildMosslandError`：
 *   1) 本地服务没有鉴权，不需要 `mosslandFetch` 的 API Key 注入与错误归一化；
 *   2) 错误信息要直接告诉用户「本地服务未启动」而不是 mossland 风格的"鉴权失败"，
 *      这种上下文只有这里知道，本函数里 throw 更合适，不要污染 mossland 模块；
 *   3) 用原生 `fetch` 而不是项目内的统一 client，可以减少这个文件对外部模块的依赖。
 */
async function transcribeLocal(
  baseUrl: string,
  wav: Buffer,
  token?: string,
): Promise<string> {
  const form = new FormData();
  form.append("model", "moss-transcribe");  // 与 OpenAI 接口对齐；服务端忽略此字段
  form.append("response_format", "json");    // 服务端固定返回 JSON；保留以备将来
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch reject 的两类常见原因要区分开，否则会把「转写超时」误报成「服务没开」，
    // 用户跟着提示去重启一个正在正常推理的服务，越排查越乱：
    //   - AbortSignal.timeout 触发 → DOMException (name === "TimeoutError") → 转写超时
    //   - 连接拒绝/网络不可达     → TypeError → 服务未启动
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `本地 ASR 转写超时（>${TRANSCRIBE_TIMEOUT_MS / 1000}s）：音频过长或 CPU 推理较慢，请稍后重试`,
      );
    }
    throw new Error("本地 ASR 服务未启动：请先启动 127.0.0.1:8328 的 FunASR 服务再通话");
  }
  if (!response.ok) {
    throw new Error(`本地 ASR 转写失败 (HTTP ${response.status})`);
  }

  const data = (await response.json()) as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("本地 ASR 转写失败：服务端未返回 text");
  }
  return data.text.trim();
}

/**
 * 本地 FunASR 批量转写会话。
 *
 * 工作流与 `MosslandAsrStream` 几乎一致（缓存一轮 PCM，stop 时整段上传转写），
 * 共享 `mossland-asr-engine.ts` 中的 `encodePcm16MonoWav` 把 PCM 帧拼成标准 WAV。
 *
 * 与 mossland 的差异：
 *   ┌─────────────┬─────────────────────────────┬────────────────────────────┐
 *   │             │ MosslandAsrStream           │ LocalAsrStream（本类）       │
 *   ├─────────────┼─────────────────────────────┼────────────────────────────┤
 *   │ 鉴权        │ API Key（start 校验非空）      │ 可选 Bearer token（本机部署 │
 *   │             │                             │ 默认不设，局域网共享时使用）   │
 *   │ 健康探测    │ 无（依赖配置非空）             │ start 时 GET /status，       │
 *   │             │                             │ 并校验 model_loaded          │
 *   │ 网络错误    │ mosslandFetch 归一化          │ 直接 throw，文案明确          │
 *   │ 转写超时    │ 来自 resolveTimeoutPolicy     │ 写死 30s（TRANSCRIBE_TIMEOUT_MS）│
 *   │ PCM 编码    │ 复用同一 encodePcm16MonoWav  │ 复用同一 encodePcm16MonoWav │
 *   └─────────────┴─────────────────────────────┴────────────────────────────┘
 *
 * 调用顺序：
 *   const stream = new LocalAsrStream(url, onFinal);
 *   await stream.start();          // 探测服务存活，失败立刻抛「未启动」
 *   stream.sendAudio(pcmFrame);    // 可多次调；空帧被丢弃
 *   const text = await stream.stop();  // 整段上传 WAV，返回最终文本
 *   // 或：再调一次 stream.stop() 也是同一个 Promise —— stop 幂等
 *
 * 配套服务端契约（与本类共同维护，若改其中一者请同步另一者）：
 *   - `GET  {baseUrl}/status`
 *       响应：`{ "model_loaded": true, ... }`（200，模型就绪）
 *             或同结构 body + HTTP 503（服务在、模型还在加载/预热中）
 *       用途：`start()` 区分「服务未启动」（fetch 抛异常）与「模型未就绪」（503），
 *             给用户不同文案，而不是都笼统报「未启动」
 *   - `POST {baseUrl}/v1/audio/transcriptions`
 *       入参：multipart/form-data，字段 `model/response_format/file`；
 *             服务端设置 ASR_TOKEN 时要求 `Authorization: Bearer <token>`
 *       响应：`{ "text": "..." }`（200）/ 401（token 错）/ 4xx-5xx 其他错误
 */
export class LocalAsrStream {
  /** PCM 帧缓存：`sendAudio` 推入，`finish` 时一次性 concat。 */
  private readonly frames: Buffer[] = [];
  /**
   * `stop()` 的去重 Promise：第一次调用时初始化 promise，之后调用直接复用。
   * 这一点对调用方非常关键 —— UI 关闭、按钮连点、上层 bug 都可能多次触发 stop，
   * 必须保证底层转写请求只发一次。
   */
  private stopPromise: Promise<string> | null = null;
  /** 规范化后的服务基址（末尾斜杠已去）。 */
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly onFinal: (text: string) => void,
    /** 服务端设置 ASR_TOKEN 时传入，转写请求带 Bearer 头；本机默认部署可省略。 */
    private readonly token?: string,
  ) {
    this.base = normalizeBaseUrl(baseUrl);
  }

  /**
   * 启动会话：探测本地服务是否存活、模型是否就绪。
   * 失败时直接抛错（带明确文案），不会走到 sendAudio。
   *
   * 三种失败各给不同文案：
   *   - fetch 抛异常 → 服务未启动（ECONNREFUSED 等）
   *   - HTTP 503     → 服务在跑但模型还在加载（FunASR 首次加载 5~20s，预热窗口内拨入）
   *   - 其他非 200   → 服务异常
   */
  async start(): Promise<void> {
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/status`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      throw new Error("本地 ASR 服务未启动：请先启动 127.0.0.1:8328 的 FunASR 服务再通话");
    }
    if (resp.status === 503) {
      throw new Error("本地 ASR 模型加载中：服务已启动但模型尚未就绪（首次加载约 5~20 秒），请稍后再试");
    }
    if (!resp.ok) {
      throw new Error(`本地 ASR 服务异常 (HTTP ${resp.status})`);
    }
  }

  /**
   * 推入一段 PCM 音频（采样率 16kHz / 16bit / 单声道）。
   *
   * 行为契约：
   *   - 空帧（length === 0）直接丢弃，避免上传空 WAV 时服务端识别错误；
   *     （mossland 同名方法就是这套语义，保持一致。）
   *   - `stop()` 已被调用后，新帧不再接收（此时 `this.stopPromise` 已创建），
   *     调用方再 sendAudio 不报错也无效果。
   *   - 内部 `Buffer.from(pcmFrame)` 复制一份以避免调用方后续 mutate 缓存里的 buffer。
   */
  sendAudio(pcmFrame: Buffer): void {
    if (this.stopPromise || pcmFrame.length === 0) return;
    this.frames.push(Buffer.from(pcmFrame));
  }

  /**
   * 结束会话，上传缓存的 PCM 整段转写。
   *
   * 幂等：第一次调用创建 promise 并发请求，后续调用直接 return 同一个 promise。
   * 这里返回一个非空字符串的 Promise —— 哪怕是空文本也要等
   * `transcribeLocal` 的语义真正决定；本类不主动抛『没识别到』错误，统一交给调用方
   * 根据返回的空字符串决定如何处理（例如 `transcribePcmWithConfiguredAsr` 把它映射成
   * 「没有识别到文字」）。
   */
  stop(): Promise<string> {
    if (!this.stopPromise) {
      this.stopPromise = this.finish();
    }
    return this.stopPromise;
  }

  /**
   * `stop()` 的实际工作：缓存空就不上传直接返回 ""，否则把 PCM 帧拼成 WAV 上传。
   *
   * 关于「缓存空」的处理：
   *   有一种情况是 VAD 判定本轮没有有效语音（例如用户只是清了嗓子），
   *   这种情况下没必要给服务端上传一个空 WAV（服务端会判 400），
   *   直接返回 "" 让调用方决定是否忽略这一轮。
   */
  private async finish(): Promise<string> {
    if (this.frames.length === 0) return "";
    const wav = encodePcm16MonoWav(Buffer.concat(this.frames));
    const text = await transcribeLocal(this.base, wav, this.token);
    if (text) this.onFinal(text);
    return text;
  }
}
