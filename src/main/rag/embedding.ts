// @xenova/transformers is ESM-only, use dynamic import in CJS context
import { checkEmbeddingModelInstalled, getProjectModelsDir } from "./model-status";
import * as path from "path";
import * as os from "os";

// ── 类型 ──
export type EmbeddingProviderIdentity = {
  provider: string;
  model: string;
  dimensions: number;
  endpoint?: string;
};

export type EmbeddingWorkerConfig =
  | { provider: "local"; modelKey: string }
  | { provider: "openai-compat"; baseUrl: string; apiKey: string; model: string };

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dims: number;
  readonly name: string;
  readonly cacheIdentity?: EmbeddingProviderIdentity;
  readonly workerConfig?: EmbeddingWorkerConfig;
}

// ── 模型注册表 ──
interface ModelConfig {
  key: string;
  hfName: string;
  dims: number;
}

const LOCAL_MODELS: Record<string, ModelConfig> = {
  minilm: { key: "minilm", hfName: "Xenova/all-MiniLM-L6-v2", dims: 384 },
  bgem3:  { key: "bgem3",  hfName: "Xenova/bge-m3",          dims: 1024 },
};

const DEFAULT_MODEL_KEY = "minilm";

// ── 本地 Pipeline ──
// 每个模型 key 独立缓存 pipeline，支持多模型同时运行（minilm 管文档/记忆，bgem3 管场景识别）
const localPipelines: Map<string, any> = new Map();
const localPipelineLoads: Map<string, Promise<any>> = new Map();
let currentModelKey: string = DEFAULT_MODEL_KEY;
let localPipelineInitCount = 0;

const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

async function getLocalPipeline(modelKey?: string): Promise<any> {
  const key = modelKey || currentModelKey;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  const cached = localPipelines.get(key);
  if (cached) return cached;
  const loading = localPipelineLoads.get(key);
  if (loading) return loading;

  const load = (async () => {
    localPipelineInitCount += 1;
    const { pipeline, env } = await importEsm("@xenova/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    // 主路径：项目根 models/（用户实际放模型的地方）。
    // 兜底：HF cache，通过 cache_dir 选项传给 pipeline。
    // transformers 内部会按 (localModelPath, cache_dir) 顺序查找文件。
    env.localModelPath = getProjectModelsDir();
    const pipe = await pipeline("feature-extraction", config.hfName, {
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    localPipelines.set(key, pipe);
    return pipe;
  })();
  localPipelineLoads.set(key, load);
  try {
    return await load;
  } finally {
    localPipelineLoads.delete(key);
  }
}

export function createLocalEmbeddingProvider(modelKey?: string): EmbeddingProvider | null {
  const key = modelKey || DEFAULT_MODEL_KEY;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  // 模型缺失返回 null，调用方决定如何处理
  if (!checkEmbeddingModelInstalled(key)) {
    return null;
  }

  return {
    name: "local-" + config.hfName.split("/").pop(),
    dims: config.dims,
    cacheIdentity: {
      provider: "local",
      model: config.hfName,
      dimensions: config.dims,
    },
    workerConfig: { provider: "local", modelKey: key },

    async embed(text: string): Promise<number[]> {
      const pipe = await getLocalPipeline(key);
      const result: any = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(result.data as Float32Array);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const pipe = await getLocalPipeline(key);
      const results: number[][] = [];
      for (const text of texts) {
        const result: any = await pipe(text, { pooling: "mean", normalize: true });
        results.push(Array.from(result.data as Float32Array));
      }
      return results;
    },
  };
}

// ── OpenAI 兼容 Provider ──
export function createOpenAIEmbeddingProvider(
  baseUrl: string,
  apiKey: string,
  model = "text-embedding-ada-002"
): EmbeddingProvider {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const endpoint = normalizedBaseUrl + "/embeddings";

  return {
    name: "openai-compat-" + model,
    dims: 1536,
    cacheIdentity: {
      provider: "openai-compat",
      model,
      dimensions: 1536,
      endpoint: normalizedBaseUrl,
    },
    workerConfig: {
      provider: "openai-compat",
      baseUrl: normalizedBaseUrl,
      apiKey,
      model,
    },

    async embed(text: string): Promise<number[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return data.data[0].embedding;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ── 自动选择 Provider ──
let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(
  mode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  modelKey?: string
): EmbeddingProvider | null {
  if (cachedProvider) return cachedProvider;

  if (mode === "local") {
    cachedProvider = createLocalEmbeddingProvider(modelKey);
  } else if (mode === "cloud" && cloudBaseUrl && cloudApiKey) {
    cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey);
  } else {
    // auto 模式：优先 local，local 不存在且 cloud 配置完整时用 cloud，否则 null
    const local = createLocalEmbeddingProvider(modelKey);
    if (local) {
      cachedProvider = local;
    } else if (cloudBaseUrl && cloudApiKey) {
      cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey);
    } else {
      cachedProvider = null;
    }
  }

  return cachedProvider;
}

export async function getEmbeddingProviderIdentity(): Promise<EmbeddingProviderIdentity> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("Embedding provider is not available");

  if (provider.cacheIdentity) return provider.cacheIdentity;

  const localModel = Object.values(LOCAL_MODELS).find(
    (model) => provider.name === "local-" + model.hfName.split("/").pop(),
  );
  if (localModel) {
    return {
      provider: "local",
      model: localModel.hfName,
      dimensions: provider.dims,
    };
  }

  const cloudModelPrefix = "openai-compat-";
  if (provider.name.startsWith(cloudModelPrefix)) {
    return {
      provider: "openai-compat",
      model: provider.name.slice(cloudModelPrefix.length),
      dimensions: provider.dims,
    };
  }

  return {
    provider: provider.name,
    model: provider.name,
    dimensions: provider.dims,
  };
}

export function getEmbeddingWorkerConfig(): EmbeddingWorkerConfig {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error("Embedding provider is not available");
  if (provider.workerConfig) return provider.workerConfig;
  return { provider: "local", modelKey: currentModelKey };
}

export function getCurrentModelKey(): string {
  return currentModelKey;
}

export function getCurrentModelDims(): number {
  const config = LOCAL_MODELS[currentModelKey];
  return config ? config.dims : 384;
}

export function switchEmbeddingModel(modelKey: string): void {
  const config = LOCAL_MODELS[modelKey];
  if (!config) throw new Error("Unknown embedding model: " + modelKey);
  cachedProvider = null;
  localPipelines.delete(currentModelKey);
  localPipelineLoads.delete(currentModelKey);
  currentModelKey = modelKey;
}

export function resetEmbeddingProvider(): void {
  cachedProvider = null;
  localPipelines.clear();
  localPipelineLoads.clear();
  currentModelKey = DEFAULT_MODEL_KEY;
  localPipelineInitCount = 0;
}

export function getEmbeddingDiagnostics(): {
  currentModelKey: string;
  cachedPipelineKeys: string[];
  loadingPipelineKeys: string[];
  localPipelineInitCount: number;
} {
  return {
    currentModelKey,
    cachedPipelineKeys: Array.from(localPipelines.keys()),
    loadingPipelineKeys: Array.from(localPipelineLoads.keys()),
    localPipelineInitCount,
  };
}

// ── 场景识别专用 provider（固定 bge-m3，不受 RAG 模型切换影响）──
let sceneProvider: EmbeddingProvider | null = null;

/**
 * 获取场景识别专用的 embedding provider（固定 bge-m3）。
 * 和文档/记忆的 provider 独立——RAG 切换模型不影响场景识别。
 * 模型不存在时返回 null。
 */
export function getSceneEmbeddingProvider(): EmbeddingProvider | null {
  if (!sceneProvider) {
    sceneProvider = createLocalEmbeddingProvider("bgem3");
  }
  return sceneProvider;
}

export { checkEmbeddingModelInstalled };
