// Global type augmentations for renderer

import type { ReviewSnapshot } from "../shared/review-types";
import type { AppUpdateApi } from "../shared/app-update";

interface SystemApi {
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

interface ReviewApi {
  get: (runId: string) => Promise<ReviewSnapshot | null>;
}

declare global {
  interface Window {
    system?: SystemApi;
    review?: ReviewApi;
    appUpdate?: AppUpdateApi;
  }
}

// Vite ?raw 导入：把 .md 文件内联为字符串（renderMarkdown 渲染用）
declare module "*.md?raw" {
  const content: string;
  export default content;
}

// Vite 静态资源导入：返回解析后的 URL 字符串
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}

export {};
