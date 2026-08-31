import { logger, LogTag } from "../../logger";
import { getEmbeddingProvider, getSceneEmbeddingProvider } from "../../rag/embedding";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "../../sticker-descriptions";
import { buildCachedStickerEmbeddingIndex } from "../../sticker-embedding-cache";
import type { StickerEmbeddingEntry } from "../../sticker-embedder";
import { loadUserStickerManifest } from "../../sticker-storage";
import { buildCachedSceneIndex } from "../../scene-embedding-cache";
import type { SceneIndex } from "../../scene-embedder";

export interface EmbeddingIndexService {
  getStickerEmbeddingIndex(): StickerEmbeddingEntry[] | null;
  getSceneEmbeddingIndex(): SceneIndex | null;
  refreshStickerEmbeddingIndex(reason: string): void;
  refreshSceneEmbeddingIndex(reason: string): void;
  invalidateStickerEmbeddingIndex(): void;
  invalidateSceneEmbeddingIndex(): void;
  scheduleStartupRefreshes(delayMs?: number): void;
}

export function createEmbeddingIndexService(): EmbeddingIndexService {
  let stickerEmbeddingIndex: StickerEmbeddingEntry[] | null = null;
  let stickerEmbeddingRefreshSeq = 0;
  let sceneEmbeddingIndex: SceneIndex | null = null;
  let sceneEmbeddingRefreshSeq = 0;

  function refreshStickerEmbeddingIndex(reason: string): void {
    const seq = ++stickerEmbeddingRefreshSeq;
    void (async () => {
      try {
        const provider = getEmbeddingProvider();
        if (!provider) {
          if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
          console.warn("[StickerEmbedding] Model not found. Sticker matching disabled.");
          return;
        }

        const index = await buildCachedStickerEmbeddingIndex(
          provider,
          BUILT_IN_STICKER_DESCRIPTIONS,
          loadUserStickerManifest(),
        );
        if (seq !== stickerEmbeddingRefreshSeq) return;
        stickerEmbeddingIndex = index;
        logger.info(LogTag.StickerEmbed, `index ready (${reason}): ${index.length} entries`);
      } catch (err) {
        if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
        console.error("[StickerEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
      }
    })();
  }

  function refreshSceneEmbeddingIndex(reason: string): void {
    const seq = ++sceneEmbeddingRefreshSeq;
    void (async () => {
      try {
        const sceneProvider = getSceneEmbeddingProvider();
        if (!sceneProvider) {
          if (seq === sceneEmbeddingRefreshSeq) sceneEmbeddingIndex = null;
          console.warn("[SceneEmbedding] bge-m3 model not found. Scene embedding disabled.");
          return;
        }

        const index = await buildCachedSceneIndex(sceneProvider);
        if (seq !== sceneEmbeddingRefreshSeq) return;
        sceneEmbeddingIndex = index;
        logger.info(LogTag.SceneEmbed, "index ready:", Object.keys(index.scenes).length, "scenes", `(${reason})`);
      } catch (err) {
        if (seq === sceneEmbeddingRefreshSeq) sceneEmbeddingIndex = null;
        console.error("[SceneEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
      }
    })();
  }

  return {
    getStickerEmbeddingIndex: () => stickerEmbeddingIndex,
    getSceneEmbeddingIndex: () => sceneEmbeddingIndex,
    refreshStickerEmbeddingIndex,
    refreshSceneEmbeddingIndex,
    invalidateStickerEmbeddingIndex: () => {
      stickerEmbeddingIndex = null;
    },
    invalidateSceneEmbeddingIndex: () => {
      sceneEmbeddingIndex = null;
    },
    scheduleStartupRefreshes: (delayMs = 1500) => {
      setTimeout(() => {
        refreshStickerEmbeddingIndex("startup");
        refreshSceneEmbeddingIndex("startup");
      }, delayMs);
    },
  };
}
