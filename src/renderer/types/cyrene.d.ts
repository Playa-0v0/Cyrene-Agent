export {};

declare global {
  interface Window {
    cyrene: {
      minimize: () => void;
      hide: () => void;
      quit: () => void;
      setInteractive: (interactive: boolean) => Promise<void>;
      setTextInputActive: (active: boolean) => void;
      moveBy: (dx: number, dy: number) => void;
      moveTo: (x: number, y: number) => void;
      setDragging: (isDragging: boolean) => void;
      captureFrame: () => Promise<string | null>;
      getCursorPosition: () => Promise<{ x: number; y: number } | null>;
      onPetZoom: (callback: (zoom: number) => void) => () => void;
    };
    petChat?: {
      send: (text: string) => Promise<{ text: string; audioBase64: string; format: "wav" | "mp3"; durationMs: number }>;
      getInputVisibility: () => Promise<boolean>;
      onInputVisibility: (callback: (visible: boolean) => void) => () => void;
    };
  }
}
