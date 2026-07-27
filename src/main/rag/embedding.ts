// @xenova/transformers is ESM-only, use dynamic import in CJS context
import { checkEmbeddingModelInstalled, getProjectModelsDir } from "./model-status";
import * as path from "path";
import * as os from "os";

// ── 類型 ──
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dims: number;
  readonly name: string;
}

// ── 模型註冊表 ──
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
// 每個模型 key 獨立緩存 pipeline，支持多模型同時運行（minilm 管文檔/記憶，bgem3 管場景識別）
const localPipelines: Map<string, any> = new Map();
let currentModelKey: string = DEFAULT_MODEL_KEY;

const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

async function getLocalPipeline(modelKey?: string): Promise<any> {
  const key = modelKey || currentModelKey;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  let pipe = localPipelines.get(key);
  if (!pipe) {
    const { pipeline, env } = await importEsm("@xenova/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    // 主路徑：項目根 models/（用戶實際放模型的地方）。
    // 兜底：HF cache，通過 cache_dir 選項傳給 pipeline。
    // transformers 內部會按 (localModelPath, cache_dir) 順序查找文件。
    env.localModelPath = getProjectModelsDir();
    pipe = await pipeline("feature-extraction", config.hfName, {
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    localPipelines.set(key, pipe);
  }
  return pipe;
}

export function createLocalEmbeddingProvider(modelKey?: string): EmbeddingProvider | null {
  const key = modelKey || DEFAULT_MODEL_KEY;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  // 模型缺失返回 null，調用方決定如何處理
  if (!checkEmbeddingModelInstalled(key)) {
    return null;
  }

  return {
    name: "local-" + config.hfName.split("/").pop(),
    dims: config.dims,

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
  const endpoint = baseUrl.replace(/\/+$/, "") + "/embeddings";

  return {
    name: "openai-compat-" + model,
    dims: 1536,

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

// ── 自動選擇 Provider ──
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
    // auto 模式：優先 local，local 不存在且 cloud 配置完整時用 cloud，否則 null
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
  currentModelKey = modelKey;
}

export function resetEmbeddingProvider(): void {
  cachedProvider = null;
  localPipelines.clear();
  currentModelKey = DEFAULT_MODEL_KEY;
}

// ── 場景識別專用 provider（固定 bge-m3，不受 RAG 模型切換影響）──
let sceneProvider: EmbeddingProvider | null = null;

/**
 * 獲取場景識別專用的 embedding provider（固定 bge-m3）。
 * 和文檔/記憶的 provider 獨立——RAG 切換模型不影響場景識別。
 * 模型不存在時返回 null。
 */
export function getSceneEmbeddingProvider(): EmbeddingProvider | null {
  if (!sceneProvider) {
    sceneProvider = createLocalEmbeddingProvider("bgem3");
  }
  return sceneProvider;
}

export { checkEmbeddingModelInstalled };
