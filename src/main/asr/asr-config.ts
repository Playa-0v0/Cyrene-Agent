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
}

export type AsrConfig = AliyunAsrConfig | MosslandAsrConfig | LocalAsrConfig;

let asrConfigGetter: (() => AsrConfig | null) | null = null;

export function setAsrConfig(getter: () => AsrConfig | null): void {
  asrConfigGetter = getter;
}

export function getAsrConfig(): AsrConfig | null {
  return asrConfigGetter?.() ?? null;
}
