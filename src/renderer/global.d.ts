// Global type augmentations for renderer

import type { ReviewSnapshot } from "../shared/review-types";
import type { AppUpdateApi } from "../shared/app-update";
import type { PluginManagementApi } from "../shared/plugin-management";

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
    plugins?: PluginManagementApi;
  }
}

// 注意：静态资源（*.png / *.svg / *.md?raw 等）的 declare module 通配声明
// 不在此文件声明——本文件因类型导入而成为"模块"，模块内的通配声明不参与模块解析。
// 这些声明已移至脚本式的 assets.d.ts。

export {};
