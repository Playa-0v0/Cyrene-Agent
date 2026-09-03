export interface AliyunAsrConfig {
  engine: "aliyun";
  appKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  language: string;
}

export interface MosslandAsrConfig {
  engine: "mossland";
  apiKey: string;
}

export interface LocalAsrConfig {
  engine: "local";
  /** 本地 FunASR 服务地址，默认 http://127.0.0.1:8328 */
  baseUrl?: string;
  /**
   * 可选访问令牌。服务端以 ASR_TOKEN 启动时（典型：监听 0.0.0.0 局域网共享 GPU），
   * 转写请求需带 Authorization: Bearer <token>。本机默认部署（127.0.0.1）无需设置。
   */
  token?: string;
}

export type AsrConfig = AliyunAsrConfig | MosslandAsrConfig | LocalAsrConfig;

let asrConfigGetter: (() => AsrConfig | null) | null = null;

export function setAsrConfig(getter: () => AsrConfig | null): void {
  asrConfigGetter = getter;
}

export function getAsrConfig(): AsrConfig | null {
  return asrConfigGetter?.() ?? null;
}
