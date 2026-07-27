// Reranker module — cross-encoder reranking for RAG
import * as path from "path";
import * as os from "os";
import { app } from "electron";

// ── Types ──
export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

// ── ESM import helper (same pattern as embedding.ts) ──
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

// ── Pipeline cache ──
let lightPipeline: any = null;
let standardPipeline: any = null;

function getModelsDir(): string {
  return path.join(app.getAppPath(), "models");
}

async function loadRerankerPipeline(modelDir: string): Promise<any> {
  const { pipeline, env } = await importEsm("@xenova/transformers");

  // Save original localModelPath (embedding may have set it)
  const originalPath = env.localModelPath;
  // 主路徑：項目根 models/。兜底：HF cache，通過 cache_dir 選項傳給 pipeline。
  env.localModelPath = getModelsDir();
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;

  try {
    const pipe = await pipeline("text-classification", modelDir, {
      quantized: true,
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    console.log(`[Reranker] pipeline "${modelDir}" loaded OK`);
    return pipe;
  } finally {
    // Restore so embedding pipeline still works
    env.localModelPath = originalPath;
  }
}

// ── Lightweight reranker (ms-marco-MiniLM-L6-v2, ~23MB) ──
export async function createLightReranker(): Promise<RerankerProvider> {
  if (!lightPipeline) {
    lightPipeline = await loadRerankerPipeline("ms-marco-MiniLM-L-6-v2");
  }

  return {
    name: "ms-marco-MiniLM-L6-v2",

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];
      if (!lightPipeline) throw new Error("Light reranker not initialized");

      const start = Date.now();

      // Cross-encoder: each input is [query, doc] pair
      const inputs = documents.map((doc) => [query, doc]);
      const outputs = await lightPipeline(inputs);

      const results = documents.map((text, i) => ({
        text,
        score: outputs[i]?.score ?? 0,
      }));

      results.sort((a, b) => b.score - a.score);

      console.log(`[Reranker] light: ${documents.length} docs reranked in ${Date.now() - start}ms`);
      return results;
    },
  };
}

// ── Standard reranker (bge-reranker-base, ~279MB) ──
export async function createStandardReranker(): Promise<RerankerProvider> {
  if (!standardPipeline) {
    standardPipeline = await loadRerankerPipeline("bge-reranker-base");
  }

  return {
    name: "bge-reranker-base",

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];
      if (!standardPipeline) throw new Error("Standard reranker not initialized");

      const start = Date.now();

      const inputs = documents.map((doc) => [query, doc]);
      const outputs = await standardPipeline(inputs);

      const results = documents.map((text, i) => ({
        text,
        score: outputs[i]?.score ?? 0,
      }));

      results.sort((a, b) => b.score - a.score);

      console.log(`[Reranker] standard: ${documents.length} docs reranked in ${Date.now() - start}ms`);
      return results;
    },
  };
}

// ── Reranker manager ──
let currentReranker: RerankerProvider | null = null;
let currentRerankerMode: "light" | "standard" | "none" = "none";

/**
 * 檢查某個 rerank 模型的 onnx 文件是否存在於本地 models/ 目錄。
 * models/.gitignore 排除了 *.onnx，所以新 clone 的倉庫默認沒有這些文件。
 */
function checkRerankerModelInstalled(mode: "light" | "standard"): boolean {
  const modelDir = mode === "light" ? "ms-marco-MiniLM-L-6-v2" : "bge-reranker-base";
  const onnxPath = path.join(getModelsDir(), modelDir, "onnx", "model_quantized.onnx");
  try {
    const fs = require("fs");
    return fs.existsSync(onnxPath);
  } catch {
    return false;
  }
}

/**
 * 返回所有 rerank 模型的安裝狀態，供 UI 真實渲染（不再硬編碼"已安裝"）。
 */
export function getRerankerInstallStatus(): { light: boolean; standard: boolean } {
  return {
    light: checkRerankerModelInstalled("light"),
    standard: checkRerankerModelInstalled("standard"),
  };
}

export async function initReranker(mode: "light" | "standard" | "none"): Promise<void> {
  currentRerankerMode = mode;

  if (mode === "none") {
    currentReranker = null;
    console.log("[Reranker] disabled");
    return;
  }

  // 入口 fallback：如果 onnx 文件不存在，自動降級為 none（不拋錯，不讓 RAG init FAILED）
  if (!checkRerankerModelInstalled(mode)) {
    const modelDir = mode === "light" ? "ms-marco-MiniLM-L-6-v2" : "bge-reranker-base";
    console.warn(`[Reranker] 模型未找到 (models/${modelDir}/onnx/model_quantized.onnx)，自動降級為 none。基礎聊天和基礎 RAG 不受影響。`);
    currentRerankerMode = "none";
    currentReranker = null;
    return;
  }

  console.log(`[Reranker] initializing ${mode} mode...`);

  if (mode === "light") {
    currentReranker = await createLightReranker();
  } else {
    currentReranker = await createStandardReranker();
  }

  console.log(`[Reranker] ${mode} mode ready: ${currentReranker.name}`);
}

export function getReranker(): RerankerProvider | null {
  return currentReranker;
}

export function getRerankerMode(): "light" | "standard" | "none" {
  return currentRerankerMode;
}

export function resetReranker(): void {
  currentReranker = null;
  currentRerankerMode = "none";
  lightPipeline = null;
  standardPipeline = null;
}
