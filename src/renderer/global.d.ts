// Global type augmentations for renderer

interface SystemApi {
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

interface PaintApi {
  buildPrompt: (description: string) => Promise<string>;
  getConnections: () => Promise<Array<{
    provider: "openrouter" | "gemini";
    label: string;
    connected: boolean;
    model: string;
  }>>;
  generateImage: (payload: {
    provider: "openrouter" | "gemini";
    prompt: string;
    model: string;
    aspectRatio: string;
    resolution: "1K" | "2K" | "4K";
    quality: "auto" | "low" | "medium" | "high";
    references: Array<{ dataUrl: string; mimeType: string }>;
  }) => Promise<{ dataUrl: string; savedPath?: string }>;
  openSettings: () => void;
}

declare global {
  interface Window {
    system?: SystemApi;
    paint: PaintApi;
  }
}

export {};
